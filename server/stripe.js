// Minimal Stripe integration (Checkout + Billing Portal + webhook) using plain fetch.
// Needs STRIPE_SECRET_KEY, STRIPE_PRICE_ID and STRIPE_WEBHOOK_SECRET.

import crypto from 'crypto';

export const paymentsEnabled = () => !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);

async function stripe(path, params) {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error?.message || 'Payment provider error'), { status: 502 });
  return data;
}

export function createCheckout({ userId, customerId, baseUrl }) {
  const params = {
    mode: 'subscription',
    'line_items[0][price]': process.env.STRIPE_PRICE_ID,
    'line_items[0][quantity]': '1',
    client_reference_id: String(userId),
    success_url: `${baseUrl}/#/premium?status=success`,
    cancel_url: `${baseUrl}/#/premium?status=cancelled`,
    allow_promotion_codes: 'true',
  };
  if (customerId) params.customer = customerId;
  return stripe('checkout/sessions', params);
}

export function createPortal({ customerId, baseUrl }) {
  return stripe('billing_portal/sessions', { customer: customerId, return_url: `${baseUrl}/#/account` });
}

/** Verify a webhook payload; returns the parsed event or throws. */
export function verifyWebhook(rawBody, header) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('Webhook secret not configured');
  const parts = Object.fromEntries(
    String(header || '')
      .split(',')
      .map((p) => p.split('=')),
  );
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) throw new Error('Stale or missing timestamp');
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const sigs = String(header)
    .split(',')
    .filter((p) => p.startsWith('v1='))
    .map((p) => p.slice(3));
  const ok = sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) throw new Error('Bad signature');
  return JSON.parse(rawBody);
}
