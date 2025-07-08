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

exports.api = functions.https.onRequest(app);
