# dzwallet-node

Node.js SDK for the [DzWallet](https://dzwallet.app) payment API: accept **CIB** and **Edahabia** cards (through SATIM), create **payment links and QR codes**, check payment status and verify the signed payment notification (IPN). No dependencies. Node 18+.

> Money is only received when the status is `success`. Never mark an order as paid because the customer reached your `success_url`: use the signed IPN, or call `paymentStatus()` from your server.
> The secret key is for servers only. Never put it in a browser or mobile app.

## Install

```bash
npm install dzwallet-node
```

## Configure

```js
const { DzWallet } = require('dzwallet-node');

const dz = new DzWallet({
  mode: 'test',                           // test | live
  publicKey: process.env.DZWALLET_PUBLIC_KEY,   // TEST key in test mode, LIVE key in live mode
  secretKey: process.env.DZWALLET_SECRET_KEY,
});
```

Keys: merchant dashboard, **Setting > API Key**. Live keys exist after identity (KYC) verification. Register your domain in **Your website domains**: `ipn_url`, `success_url` and `cancel_url` must belong to it.

## Take a payment

```js
const identifier = DzWallet.newIdentifier('ORD');     // max 20 characters, save with your order first
const { redirectUrl } = await dz.initiatePayment({
  identifier, amount: 2500, details: 'Order #1042', site_name: 'My shop',
  ipn_url: 'https://yourshop.dz/dzwallet/ipn',
  success_url: 'https://yourshop.dz/thanks',
  cancel_url: 'https://yourshop.dz/cart',
  customer: { first_name: 'Amine', last_name: 'B.', email: 'amine@example.dz', mobile: '0555000000' },
});
res.redirect(redirectUrl);   // test mode: simulated page. Live mode: SATIM card page
```

## Receive the notification (IPN)

Every notification is signed on the **exact raw body** (header `X-DzWallet-Signature: t=<unix>,v1=<hex>`, `v1 = HMAC-SHA256(secret, t + "." + raw body)`), carries a signed timestamp and a unique event id. Read the raw body, not the parsed one:

```js
app.post('/dzwallet/ipn', express.raw({ type: '*/*' }), (req, res) => {
  let n;
  try {
    n = dz.verifyNotification(req.body, req.headers, { requireV2: true });   // signature + 5 minute window; throws InvalidSignatureError
  } catch (e) {
    return res.sendStatus(403);
  }
  if (alreadyProcessed(n.eventId)) return res.sendStatus(200);      // unique constraint on event id
  const order = findOrder(n.ipn.identifier);
  if (!order) return res.sendStatus(404);
  if (Math.abs(Number(n.ipn.amount) - order.total) > 0.005) return res.sendStatus(400);   // amount must match YOUR order
  if (n.ipn.isSuccess && !order.paid) markPaid(order, n.ipn.trx);   // fulfil once
  recordEvent(n.eventId);
  res.sendStatus(200);                                              // answer quickly with 2xx
});
```

- `verifyNotification(rawBody, headers, { tolerance = 300, requireV2 = false })` uses the v2 signature when DzWallet sends it and falls back to the older `signature` field (uppercase HMAC of `data.amount + identifier`) otherwise. Pass `requireV2: true` to refuse the older one.
- The event id is read from the signed body, so a replayed request cannot dodge the duplicate check by changing a header. It is the same on every retry and on manual redelivery.
- Lower level: `verifyWebhook(rawBody, header)` returns `{ timestamp, eventId }`; `parseIpnForm(raw)` turns the body into the nested object `verifyIpn` expects.
- Retries: DzWallet retries unsuccessful deliveries with increasing delays for up to 15 attempts. Failed deliveries can be resent from the merchant dashboard (Webhook Log).

## Status and payment links

```js
const s = await dz.paymentStatus(identifier);       // s.isPaid, s.status, s.trx
const link = await dz.createPaymentLink(2500, { reference: 'ORD1042', days: 7, note: 'Room 12' });  // live keys
await dz.paymentLink('ORD1042');
await dz.reactivatePaymentLink('ORD1042');
```

## Errors

`ConfigurationError` (key missing), `TypeError` (bad parameter, nothing sent), `ApiError` (`.errors`, `.httpStatus`, `.isRateLimited`), `ConnectionError` (timeout: after `initiatePayment` the result is **unknown**, call `paymentStatus()` first), `InvalidSignatureError`. All but `TypeError` extend `DzWalletError`. TypeScript types are included.

`initiatePayment` is never retried automatically; `paymentStatus` and link reads retry on connection errors. Limit: 60 requests per minute per IP.

## Tests

```bash
npm test
```

They use a fake `fetch` and never call DzWallet.

MIT licence.
