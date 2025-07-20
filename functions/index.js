require('dotenv').config();
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); // replace with your Stripe secret key

admin.initializeApp();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());


app.post('/create-connected-account', async (req, res) => {
  try {
    console.log('[LOG] Incoming request to /create-connected-account');

    const email = req.body.email || 'jenny.rosen@example.com';
    console.log('[LOG] Email:', email);

    const account = await stripe.accounts.create({
      controller: {
        losses: {
          payments: 'application',
        },
        fees: {
          payer: 'application',
        },
        stripe_dashboard: {
          type: 'express',
        },
      },
    });
    console.log('[LOG] Account created:', account.id);

    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: 'https://yourapp.com/reauth',
      return_url: 'https://yourapp.com/return',
      type: 'account_onboarding',
    });
    console.log('[LOG] Account link created:', accountLink.url);

    res.status(200).json({ url: accountLink.url, accountId: account.id });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/payment-sheet', async (req, res) => {
  try {
    const { amount, currency, connectedAccountId } = req.body;

    if (!amount || !currency || !connectedAccountId) {
      return res.status(400).json({ error: 'Missing amount, currency, or connectedAccountId' });
    }

    // 1. Create a customer (or use an existing one if you have UID logic)
    const customer = await stripe.customers.create();

    // 2. Create an ephemeral key (used on mobile for customer access)
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customer.id },
      { apiVersion: '2024-09-30.acacia' } // Match your client SDK version
    );

    // 3. Create a PaymentIntent with destination (Stripe Connect)
    const paymentIntent = await stripe.paymentIntents.create({
      amount, // e.g. 1099 for €10.99
      currency, // 'eur', 'myr', etc.
      customer: customer.id,
      automatic_payment_methods: { enabled: true },
      application_fee_amount: Math.floor(amount * 0.1), // e.g. 10% platform fee
      transfer_data: {
        destination: connectedAccountId, // The connected account (acct_xxx)
      },
    });

    // 4. Return secrets to the client
    res.status(200).json({
      paymentIntent: paymentIntent.client_secret,
      ephemeralKey: ephemeralKey.secret,
      customer: customer.id,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY, // your real publishable key
    });

  } catch (error) {
    console.error('[Stripe Payment Sheet Error]', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/create-deposit-intent', async (req, res) => {
  try {
    const { amount, currency, customerId } = req.body;

    if (!amount || !currency) {
      return res.status(400).json({ error: 'Missing amount or currency' });
    }

    // Optional: reuse customer ID from earlier or create one
    const customer = customerId || (await stripe.customers.create()).id;

    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer },
      { apiVersion: '2024-09-30.acacia' }
    );

    const depositIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      customer,
      automatic_payment_methods: { enabled: true },
      capture_method: 'manual', // Important: manual capture to "hold" the funds
    });

    res.status(200).json({
      paymentIntent: depositIntent.client_secret,
      ephemeralKey: ephemeralKey.secret,
      customer,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });

  } catch (error) {
    console.error('[Deposit Intent Error]', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/platform-payment', async (req, res) => {
  try {
    const { amount, currency, customerId } = req.body;

    if (!amount || !currency) {
      return res.status(400).json({ error: 'Missing required fields: amount or currency' });
    }

    // 1. Create customer if not provided
    const customer = customerId || (await stripe.customers.create()).id;

    // 2. Create an ephemeral key for the Stripe Payment Sheet
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer },
      { apiVersion: '2024-09-30.acacia' } // match Stripe SDK version
    );

    // 3. Create PaymentIntent that pays fully to platform
    const paymentIntent = await stripe.paymentIntents.create({
      amount, // in smallest currency unit, e.g. 200 for £2
      currency,
      customer,
      automatic_payment_methods: { enabled: true },
    });

    // 4. Return client-side secrets for Stripe Payment Sheet
    return res.status(200).json({
      paymentIntent: paymentIntent.client_secret,
      ephemeralKey: ephemeralKey.secret,
      customer,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });

  } catch (error) {
    console.error('[Platform Payment Error]', error);
    return res.status(500).json({ error: error.message });
  }
});

app.post('/hold-payment', async (req, res) => {
  try {
    const { amount, currency, customerId, rentalId } = req.body;

    if (!amount || !currency || !rentalId) {
      return res.status(400).json({ error: 'Missing amount, currency, or rentalId' });
    }

    // Create customer if not passed in
    const customer = customerId || (await stripe.customers.create()).id;

    // Create an ephemeral key (for Stripe Payment Sheet on mobile)
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer },
      { apiVersion: '2024-09-30.acacia' }
    );

    // Create PaymentIntent (funds go to your platform balance)
    const paymentIntent = await stripe.paymentIntents.create({
      amount, // e.g. 4000 for £40.00
      currency, // e.g. 'GBP'
      customer,
      automatic_payment_methods: { enabled: true },
      transfer_group: `rental_${rentalId}`, // for tracking
      metadata: {
        rentalId,
        purpose: 'rental_hold',
      },
    });

    res.status(200).json({
      paymentIntent: paymentIntent.client_secret,
      ephemeralKey: ephemeralKey.secret,
      customer,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });

  } catch (error) {
    console.error('[Hold Payment Error]', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/release-to-lender', async (req, res) => {
  try {
    const { amount, currency, connectedAccountId, rentalId } = req.body;

    if (!amount || !currency || !connectedAccountId || !rentalId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Perform manual transfer to the connected account
    const transfer = await stripe.transfers.create({
      amount, // e.g. 4000 = £40.00
      currency, // 'GBP'
      destination: connectedAccountId, // Lender's Stripe account ID
      transfer_group: `rental_${rentalId}`, // match PaymentIntent's transfer_group
      metadata: {
        rentalId,
        released_by: 'Borrower Confirmation',
      },
    });

    res.status(200).json({ success: true, transferId: transfer.id });

  } catch (error) {
    console.error('[Release Transfer Error]', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/refund-deposit', async (req, res) => {
  const { paymentIntentId, amountToRefundInPence } = req.body;

  try {
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntentId,
      amount: amountToRefundInPence, // e.g. 1000 = £10
    });

    res.json({ success: true, refund });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

exports.api = functions.https.onRequest(app);
