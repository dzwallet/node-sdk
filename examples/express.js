// npm i express   (then set DZWALLET_PUBLIC_KEY / DZWALLET_SECRET_KEY)
const express = require('express');
const { DzWallet, InvalidSignatureError } = require('dzwallet-node');

const dz = new DzWallet({ mode: 'test', publicKey: process.env.DZWALLET_PUBLIC_KEY, secretKey: process.env.DZWALLET_SECRET_KEY });
const app = express();

const orders = new Map(); // replace with your database

app.post('/pay', async (req, res) => {
  const identifier = DzWallet.newIdentifier('ORD');
  orders.set(identifier, { total: 2500, paid: false });          // save BEFORE redirecting
  const p = await dz.initiatePayment({
    identifier, amount: 2500, details: 'Order #1042', site_name: 'My shop',
    ipn_url: 'https://yourshop.dz/dzwallet/ipn', success_url: 'https://yourshop.dz/thanks', cancel_url: 'https://yourshop.dz/cart',
    customer: { first_name: 'Amine', last_name: 'B.', email: 'amine@example.dz', mobile: '0555000000' },
  });
  res.redirect(p.redirectUrl);
});

const seenEvents = new Set(); // replace with a table that has a unique constraint on event_id

app.post('/dzwallet/ipn', express.raw({ type: '*/*' }), (req, res) => {   // raw body: the signature covers the exact bytes
  let n;
  try {
    n = dz.verifyNotification(req.body, req.headers);   // signature + timestamp window
  } catch (e) {
    if (e instanceof InvalidSignatureError) return res.sendStatus(403);
    throw e;
  }
  if (n.eventId && seenEvents.has(n.eventId)) return res.sendStatus(200);   // duplicate or manual redelivery
  const order = orders.get(n.ipn.identifier);
  if (!order) return res.sendStatus(404);
  if (Math.abs(Number(n.ipn.amount) - order.total) > 0.005) return res.sendStatus(400);
  if (n.ipn.isSuccess && !order.paid) order.paid = true;                    // idempotent
  if (n.eventId) seenEvents.add(n.eventId);
  res.sendStatus(200);
});

app.get('/thanks', async (req, res) => {
  // never trust this page alone: ask DzWallet
  const s = await dz.paymentStatus(String(req.query.id));
  res.send(s.isPaid ? 'Paid' : `Status: ${s.status}`);
});

app.listen(3000);
