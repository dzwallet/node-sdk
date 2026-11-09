'use strict';

const crypto = require('node:crypto');
const { ApiError, ConfigurationError, ConnectionError, InvalidSignatureError } = require('./errors');

/** Flattens nested objects/arrays into form fields: customer[first_name], gateway_methods[] ... */
function toForm(obj, prefix, out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item) => out.append(`${key}[]`, String(item)));
    else if (typeof v === 'object') toForm(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Turns a raw form body (status=..&data[amount]=..) into the nested object verifyIpn expects. */
function parseIpnForm(raw) {
  const out = {};
  for (const [k, v] of new URLSearchParams(String(raw))) {
    const m = /^([^\[\]]+)\[([^\[\]]*)\]$/.exec(k);
    if (m) {
      if (typeof out[m[1]] !== 'object' || out[m[1]] === null) out[m[1]] = {};
      out[m[1]][m[2]] = v;
    } else out[k] = v;
  }
  return out;
}

class DzWallet {
  /**
   * @param {{mode?:'test'|'live', publicKey:string, secretKey?:string, baseUrl?:string, timeoutMs?:number, statusRetries?:number, fetch?:Function}} config
   */
  constructor(config = {}) {
    this.mode = config.mode === 'live' ? 'live' : 'test';
    this.publicKey = (config.publicKey || '').trim();
    this.secretKey = (config.secretKey || '').trim();
    this.baseUrl = (config.baseUrl || 'https://dzwallet.app').replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs || 30000;
    this.statusRetries = config.statusRetries === undefined ? 2 : config.statusRetries;
    this._fetch = config.fetch || globalThis.fetch;
    if (typeof this._fetch !== 'function') throw new ConfigurationError('fetch is not available (Node 18+ needed)');
  }

  _needPublic() {
    if (!this.publicKey) throw new ConfigurationError('publicKey is not set.');
    return this.publicKey;
  }

  _needSecret() {
    if (!this.secretKey) throw new ConfigurationError('secretKey is not set.');
    return this.secretKey;
  }

  async _call(method, path, { headers = {}, form = null, retryable = false } = {}) {
    const attempts = retryable ? this.statusRetries + 1 : 1;
    let lastError;
    for (let i = 0; i < attempts; i++) {
      let res;
      try {
        res = await this._fetch(this.baseUrl + path, {
          method,
          headers: { Accept: 'application/json', ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...headers },
          body: form ? form.toString() : undefined,
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        lastError = new ConnectionError(`Could not reach DzWallet: ${e.message}`);
        if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      return this._parse(res);
    }
    throw lastError;
  }

  async _parse(res) {
    let json = {};
    try {
      const j = JSON.parse(await res.text());
      if (j && typeof j === 'object') json = j;
    } catch (_) {}
    const failed = res.status < 200 || res.status >= 300 || json.status === 'error';
    if (failed) {
      let errors = [];
      if (json.message !== undefined) errors = Array.isArray(json.message) ? json.message.map(String) : [String(json.message)];
      if (!errors.length && json.errors && typeof json.errors === 'object') {
        for (const list of Object.values(json.errors)) errors.push(...[].concat(list).map(String));
      }
      throw new ApiError(errors.length ? errors.join('; ') : `HTTP ${res.status}`, errors, res.status);
    }
    return json;
  }

  /* ----------------------------- card payment ----------------------------- */

  /**
   * Starts a payment, returns { redirectUrl, identifier }. Send the customer to redirectUrl.
   * NEVER retried automatically: after a ConnectionError call paymentStatus(identifier) first.
   */
  async initiatePayment(params) {
    const p = { currency: 'DZD', gateway_methods: ['Satim'], ...params };
    p.currency = String(p.currency).toUpperCase();
    this._validateInitiate(p);
    p.public_key = this._needPublic();
    const path = this.mode === 'test' ? '/test/payment/initiate' : '/payment/initiate';
    const json = await this._call('POST', path, { form: toForm(p) });
    if (typeof json.redirect_url !== 'string' || !json.redirect_url) throw new ApiError('The API did not return a checkout address.');
    return { redirectUrl: json.redirect_url, identifier: String(p.identifier), raw: json };
  }

  _validateInitiate(p) {
    const errors = [];
    for (const k of ['identifier', 'details', 'ipn_url', 'success_url', 'cancel_url', 'site_name']) {
      if (p[k] === undefined || String(p[k]).trim() === '') errors.push(`${k} is required`);
    }
    if (p.identifier && String(p.identifier).length > 20) errors.push('identifier must be at most 20 characters');
    if (p.details && String(p.details).length > 100) errors.push('details must be at most 100 characters');
    if (!(Number(p.amount) > 0)) errors.push('amount must be a number greater than 0');
    for (const k of ['ipn_url', 'success_url', 'cancel_url']) {
      if (p[k] && !/^https?:\/\//i.test(String(p[k]))) errors.push(`${k} must start with http:// or https://`);
    }
    const c = p.customer;
    if (!c || typeof c !== 'object') errors.push('customer is required');
    else for (const k of ['first_name', 'last_name', 'email', 'mobile']) if (!c[k] || String(c[k]).trim() === '') errors.push(`customer.${k} is required`);
    if (errors.length) throw new TypeError(errors.join('; '));
  }

  /** Current state. Only isPaid proves the money was received. Safe to retry. */
  async paymentStatus(identifier) {
    if (!identifier) throw new TypeError('identifier is required');
    const json = await this._call('POST', '/api/payment/status', {
      form: toForm({ public_key: this._needPublic(), identifier }),
      retryable: true,
    });
    const d = json.data && typeof json.data === 'object' ? { ...json, ...json.data } : json;
    if (typeof d.payment_status !== 'string') throw new ApiError('The API did not return a payment status.');
    const status = d.payment_status;
    return {
      status,
      identifier: d.identifier ? String(d.identifier) : String(identifier),
      amount: d.amount !== undefined ? String(d.amount) : null,
      currency: d.currency || null,
      trx: d.trx || null,
      isPaid: status === 'success',
      isFinal: ['success', 'rejected', 'cancelled'].includes(status),
      raw: json,
    };
  }

  /* ------------------------ payment links (live keys) ------------------------ */

  _linkHeaders() {
    return { 'X-Public-Key': this._needPublic(), 'X-Secret-Key': this._needSecret() };
  }

  _makeLink(json) {
    const d = json.data;
    if (!d || !d.url) throw new ApiError('The API did not return a payment link.');
    return {
      trx: String(d.trx || ''),
      amount: String(d.amount ?? ''),
      currency: d.currency || 'DZD',
      status: String(d.status || ''),
      url: String(d.url),
      printUrl: d.print_url || null,
      expiresAt: d.expires_at || null,
      reference: d.reference || null,
      identifier: d.identifier || null,
      emailSent: json.email_sent !== undefined ? Boolean(json.email_sent) : d.email_sent !== undefined ? Boolean(d.email_sent) : null,
      isOpen: d.status === 'pending',
      raw: json,
    };
  }

  /** The same reference with the same amount returns the same link. */
  async createPaymentLink(amount, options = {}) {
    if (!(Number(amount) > 0)) throw new TypeError('amount must be a number greater than 0');
    if (options.days !== undefined && (options.days < 1 || options.days > 30)) throw new TypeError('days must be between 1 and 30');
    if (options.note && [...String(options.note)].length > 100) throw new TypeError('note must be at most 100 characters');
    if (options.reference !== undefined && !/^[A-Za-z0-9_-]{1,15}$/.test(String(options.reference))) {
      throw new TypeError('reference: 1-15 characters, letters, digits, _ and - only');
    }
    if (options.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(options.email))) throw new TypeError('email is not valid');
    const json = await this._call('POST', '/api/payment-links', { headers: this._linkHeaders(), form: toForm({ amount: String(amount), ...options }) });
    return this._makeLink(json);
  }

  async paymentLink(reference) {
    const json = await this._call('GET', `/api/payment-links/${encodeURIComponent(reference)}`, { headers: this._linkHeaders(), retryable: true });
    return this._makeLink(json);
  }

  async reactivatePaymentLink(reference) {
    const json = await this._call('POST', `/api/payment-links/${encodeURIComponent(reference)}/reactivate`, { headers: this._linkHeaders() });
    return this._makeLink(json);
  }

  /* ---------------------------------- IPN ---------------------------------- */

  /** signature = UPPERCASE(HMAC-SHA256(data.amount + identifier, SECRET_KEY)) */
  signature(amount, identifier) {
    return crypto.createHmac('sha256', this._needSecret()).update(String(amount) + String(identifier)).digest('hex').toUpperCase();
  }

  /**
   * Verifies a notification (the parsed form body) and returns it. Throws InvalidSignatureError.
   * Pass the identifier and amount of YOUR order, then check isSuccess.
   */
  /**
   * Verify the v2 notification signature on the EXACT raw request body.
   * Header X-DzWallet-Signature: t=<unix>,v1=<hex>; signed text is "<t>.<raw body>" with your secret key.
   * Rejects bad signatures and timestamps further than `tolerance` seconds from now.
   * The event id is read from the signed body (a header can be changed by anyone who captured the request).
   * @returns {{timestamp:number, eventId:string|null}}
   */
  verifyWebhook(rawBody, signatureHeader, options = {}) {
    const tolerance = options.tolerance === undefined ? 300 : options.tolerance;
    const now = options.now === undefined ? Math.floor(Date.now() / 1000) : options.now;
    const raw = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody === undefined || rawBody === null ? '' : rawBody);
    let timestamp = null;
    const sigs = [];
    for (const part of String(signatureHeader || '').split(',')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (k === 't' && /^\d+$/.test(v)) timestamp = parseInt(v, 10);
      else if (k === 'v1') sigs.push(v.toLowerCase());
    }
    if (timestamp === null || !sigs.length) throw new InvalidSignatureError('The signature header is missing or malformed.');
    const expected = crypto.createHmac('sha256', this._needSecret()).update(`${timestamp}.${raw}`).digest('hex');
    if (!sigs.some((sig) => safeEqual(expected, sig))) throw new InvalidSignatureError('The notification signature is not valid.');
    if (Math.abs(now - timestamp) > tolerance) throw new InvalidSignatureError('The notification timestamp is outside the allowed window.');
    const body = new URLSearchParams(raw);
    const eventId = body.get('event_id');
    if (options.eventIdHeader && eventId && !safeEqual(eventId, options.eventIdHeader)) {
      throw new InvalidSignatureError('The event id header does not match the signed body.');
    }
    return { timestamp, eventId: eventId || null };
  }

  /**
   * Verify a notification request. Uses the v2 signature when the X-DzWallet-Signature header is present,
   * otherwise the older signature field (refused when options.requireV2 is true).
   * @param {string|Buffer} rawBody  the body exactly as received
   * @param {Object} headers         request headers (any letter case)
   * @returns {{ipn:object, eventId:string|null}}
   */
  verifyNotification(rawBody, headers = {}, options = {}) {
    const h = {};
    for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    const raw = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
    const payload = parseIpnForm(raw);
    if (h['x-dzwallet-signature']) {
      const meta = this.verifyWebhook(raw, h['x-dzwallet-signature'], { ...options, eventIdHeader: h['x-dzwallet-event-id'] });
      const identifier = String(payload.identifier || '');
      const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
      if (!identifier || data.amount === undefined) throw new InvalidSignatureError('The notification is incomplete.');
      return {
        eventId: meta.eventId,
        ipn: { status: String(payload.status || ''), identifier, amount: String(data.amount), trx: data.payment_trx ? String(data.payment_trx) : null, isSuccess: payload.status === 'success', data, raw: payload },
      };
    }
    if (options.requireV2) throw new InvalidSignatureError('A signed v2 notification is required.');
    return { ipn: this.verifyIpn(payload), eventId: null };
  }

  verifyIpn(body, expectedIdentifier, expectedAmount) {
    const b = body || {};
    const identifier = String(b.identifier || '');
    const signature = String(b.signature || '');
    const data = b.data && typeof b.data === 'object' ? b.data : {};
    if (!identifier || !signature || data.amount === undefined) throw new InvalidSignatureError('The notification is incomplete.');
    if (!safeEqual(this.signature(data.amount, identifier), signature.toUpperCase())) throw new InvalidSignatureError('The notification signature is not valid.');
    if (expectedIdentifier !== undefined && expectedIdentifier !== null && !safeEqual(expectedIdentifier, identifier)) {
      throw new InvalidSignatureError('The notification is for another order.');
    }
    if (expectedAmount !== undefined && expectedAmount !== null && Math.abs(Number(expectedAmount) - Number(data.amount)) > 0.005) {
      throw new InvalidSignatureError('The notification amount is not the expected amount.');
    }
    return {
      status: String(b.status || ''),
      identifier,
      amount: String(data.amount),
      trx: data.payment_trx ? String(data.payment_trx) : null,
      isSuccess: b.status === 'success',
      data,
      raw: b,
    };
  }

  /** A unique identifier of at most 20 characters. */
  static newIdentifier(prefix = 'DZ') {
    return (String(prefix).replace(/[^A-Za-z0-9]/g, '').slice(0, 6) + crypto.randomBytes(8).toString('hex').toUpperCase()).slice(0, 20);
  }
}

module.exports = { DzWallet, toForm, parseIpnForm };
