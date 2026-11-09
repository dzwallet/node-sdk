'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DzWallet, ApiError, ConnectionError, InvalidSignatureError, ConfigurationError, toForm } = require('../src');

function fakeFetch(queue, calls) {
  return async (url, init) => {
    calls.push({ url, init });
    const r = queue.shift();
    if (r instanceof Error) throw r;
    return { status: r[0], text: async () => r[1] };
  };
}
const good = {
  identifier: 'ORD1', amount: 1000, details: 'x', ipn_url: 'https://a.dz/i', success_url: 'https://a.dz/s', cancel_url: 'https://a.dz/c', site_name: 'S',
  customer: { first_name: 'A', last_name: 'B', email: 'a@b.dz', mobile: '0555' },
};
const mk = (queue, calls, cfg = {}) => new DzWallet({ publicKey: 'test_pub', secretKey: 'test_sec', fetch: fakeFetch(queue, calls), ...cfg });

test('toForm flattens nested fields like PHP', () => {
  const s = toForm({ a: 1, customer: { email: 'x@y.dz' }, gateway_methods: ['Satim'], skip: undefined }).toString();
  assert.equal(decodeURIComponent(s), 'a=1&customer[email]=x@y.dz&gateway_methods[]=Satim');
});

test('initiate uses the test endpoint and sends defaults', async () => {
  const calls = [];
  const dz = mk([[200, JSON.stringify({ status: 'success', redirect_url: 'https://dzwallet.app/test/payment/checkout?x' })]], calls);
  const p = await dz.initiatePayment(good);
  assert.equal(p.redirectUrl, 'https://dzwallet.app/test/payment/checkout?x');
  assert.equal(calls[0].url, 'https://dzwallet.app/test/payment/initiate');
  const body = decodeURIComponent(calls[0].init.body);
  assert.match(body, /public_key=test_pub/);
  assert.match(body, /currency=DZD/);
  assert.match(body, /gateway_methods\[\]=Satim/);
  assert.match(body, /customer\[first_name\]=A/);
  assert.doesNotMatch(body, /test_sec/);
});

test('live mode uses the live endpoint', async () => {
  const calls = [];
  const dz = mk([[200, JSON.stringify({ redirect_url: 'https://x' })]], calls, { mode: 'live' });
  await dz.initiatePayment(good);
  assert.equal(calls[0].url, 'https://dzwallet.app/payment/initiate');
});

test('validation errors are thrown before any request', async () => {
  const calls = [];
  const dz = mk([], calls);
  const bad = { ...good, customer: { ...good.customer, email: '' } };
  await assert.rejects(() => dz.initiatePayment(bad), /customer\.email is required/);
  await assert.rejects(() => dz.initiatePayment({ ...good, amount: 0 }), /amount/);
  await assert.rejects(() => dz.initiatePayment({ ...good, identifier: 'A'.repeat(21) }), /identifier/);
  assert.equal(calls.length, 0);
});

test('missing public key', async () => {
  await assert.rejects(() => new DzWallet({ fetch: async () => {} }).initiatePayment(good), ConfigurationError);
});

test('API error becomes ApiError', async () => {
  const dz = mk([[401, JSON.stringify({ status: 'error', message: ['Invalid api key'] })]], []);
  await assert.rejects(() => dz.initiatePayment(good), (e) => e instanceof ApiError && e.message === 'Invalid api key' && e.httpStatus === 401);
  const dz2 = mk([[429, '{}']], [], { statusRetries: 0 });
  await assert.rejects(() => dz2.paymentStatus('X'), (e) => e.isRateLimited === true);
});

test('initiate is NOT retried on a connection error', async () => {
  const calls = [];
  const dz = mk([new Error('timeout'), [200, JSON.stringify({ redirect_url: 'https://x' })]], calls);
  await assert.rejects(() => dz.initiatePayment(good), ConnectionError);
  assert.equal(calls.length, 1);
});

test('status IS retried and reports paid', async () => {
  const calls = [];
  const dz = mk([new Error('t1'), new Error('t2'), [200, JSON.stringify({ status: 'success', payment_status: 'success', identifier: 'ORD1', amount: '1000.00000000', trx: 'T1' })]], calls);
  const s = await dz.paymentStatus('ORD1');
  assert.equal(s.isPaid, true);
  assert.equal(s.isFinal, true);
  assert.equal(s.trx, 'T1');
  assert.equal(calls.length, 3);
  const p = mk([[200, JSON.stringify({ payment_status: 'pending' })]], []);
  assert.equal((await p.paymentStatus('Z')).isPaid, false);
});

const link = { status: 'success', message: 'Payment link created', data: { trx: 'H3K9', amount: 2500, currency: 'DZD', status: 'pending', url: 'https://dzwallet.app/qr/H3K9/abc', print_url: 'https://dzwallet.app/qr/H3K9/abc/code', reference: 'ORD1042', identifier: 'QRA03ORD1042' } };

test('payment links', async () => {
  const calls = [];
  const dz = mk([[200, JSON.stringify(link)], [200, JSON.stringify(link)], [200, JSON.stringify(link)]], calls);
  const l = await dz.createPaymentLink(2500, { reference: 'ORD1042', days: 3 });
  assert.equal(l.isOpen, true);
  assert.equal(l.identifier, 'QRA03ORD1042');
  assert.equal(calls[0].init.headers['X-Secret-Key'], 'test_sec');
  assert.match(decodeURIComponent(calls[0].init.body), /amount=2500/);
  await dz.paymentLink('ORD 1');
  assert.equal(calls[1].url, 'https://dzwallet.app/api/payment-links/ORD%201');
  assert.equal(calls[1].init.method, 'GET');
  await dz.reactivatePaymentLink('ORD1042');
  assert.match(calls[2].url, /\/ORD1042\/reactivate$/);
  await assert.rejects(() => dz.createPaymentLink(100, { reference: 'bad ref!' }), /reference/);
  await assert.rejects(() => dz.createPaymentLink(100, { days: 31 }), /days/);
});

const sig = (amount, id, secret = 'test_sec') => crypto.createHmac('sha256', secret).update(amount + id).digest('hex').toUpperCase();
const ipn = (over = {}) => ({ status: 'success', signature: sig('1000.00000000', 'ORD1'), identifier: 'ORD1', data: { payment_trx: 'T1', amount: '1000.00000000', currency: 'DZD' }, ...over });

test('IPN verification', () => {
  const dz = mk([], []);
  const r = dz.verifyIpn(ipn(), 'ORD1', 1000);
  assert.equal(r.isSuccess, true);
  assert.equal(r.trx, 'T1');
  assert.equal(dz.verifyIpn(ipn({ signature: sig('1000.00000000', 'ORD1').toLowerCase() })).identifier, 'ORD1');
  assert.throws(() => dz.verifyIpn(ipn({ signature: 'AAAA' })), InvalidSignatureError);
  assert.throws(() => dz.verifyIpn(ipn({ signature: sig('1000.00000000', 'ORD1', 'wrong') })), InvalidSignatureError);
  assert.throws(() => dz.verifyIpn(ipn(), 'OTHER', 1000), /another order/);
  assert.throws(() => dz.verifyIpn(ipn(), 'ORD1', 999), /amount/);
  assert.throws(() => dz.verifyIpn({ status: 'success' }), /incomplete/);
  const tampered = ipn(); tampered.data.amount = '1.00000000';
  assert.throws(() => dz.verifyIpn(tampered), InvalidSignatureError);
  assert.equal(dz.verifyIpn(ipn({ status: 'rejected' })).isSuccess, false);
});

test('v2 webhook: raw body, timestamp, event id', () => {
  const dz = mk([], []);
  const raw = 'event=payment.succeeded&event_id=evt_abc&status=success&identifier=ORD1&data%5Bamount%5D=100.00&data%5Bpayment_trx%5D=T1&timestamp=1700000000';
  const hdr = (t, body, secret = 'test_sec') => `t=${t},v1=` + crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const m = dz.verifyWebhook(raw, hdr(1700000000, raw), { now: 1700000100 });
  assert.equal(m.eventId, 'evt_abc'); assert.equal(m.timestamp, 1700000000);
  assert.throws(() => dz.verifyWebhook(raw + 'x', hdr(1700000000, raw), { now: 1700000100 }), InvalidSignatureError);
  assert.throws(() => dz.verifyWebhook(raw, hdr(1700000000, raw), { now: 1700001000 }), /window/);
  assert.throws(() => dz.verifyWebhook(raw, hdr(1700000000, raw), { now: 1699999000 }), /window/);
  assert.throws(() => dz.verifyWebhook(raw, 'garbage', { now: 1700000100 }), /malformed/);
  assert.throws(() => dz.verifyWebhook(raw, hdr(1700000000, raw, 'other'), { now: 1700000100 }), InvalidSignatureError);
  assert.throws(() => dz.verifyWebhook(raw, hdr(1700000000, raw), { now: 1700000100, eventIdHeader: 'evt_other' }), /event id header/);
  assert.equal(dz.verifyWebhook(Buffer.from(raw), hdr(1700000000, raw), { now: 1700000100 }).eventId, 'evt_abc');
  const t = Math.floor(Date.now() / 1000);
  const raw2 = `event_id=evt_zz&status=success&identifier=ORD9&data%5Bamount%5D=50.00&data%5Bpayment_trx%5D=T9&timestamp=${t}`;
  const r = dz.verifyNotification(raw2, { 'X-DzWallet-Signature': hdr(t, raw2), 'X-DzWallet-Event-Id': 'evt_zz' });
  assert.equal(r.eventId, 'evt_zz'); assert.equal(r.ipn.identifier, 'ORD9'); assert.equal(r.ipn.trx, 'T9'); assert.equal(r.ipn.isSuccess, true);
  const legacy = 'status=success&identifier=ORD1&signature=' + sig('100.00', 'ORD1') + '&data%5Bamount%5D=100.00';
  assert.equal(dz.verifyNotification(legacy, {}).eventId, null);
  assert.throws(() => dz.verifyNotification(legacy, {}, { requireV2: true }), /v2/);
});

test('newIdentifier', () => {
  const id = DzWallet.newIdentifier('ORD');
  assert.ok(id.length <= 20 && id.startsWith('ORD'));
  assert.ok(DzWallet.newIdentifier('A-B_C!!!!!!').length <= 20);
});
