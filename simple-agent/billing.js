// Stripe billing for co|op: checkout, the customer portal, and the webhook that switches plans on.
//
//   POST /web/billing/checkout   {plan: 'starter'|'pro'|'business'|'topup'}  -> { url }  (a Stripe Checkout page)
//   POST /web/billing/portal     {}                                          -> { url }  (Stripe's billing portal)
//   POST /stripe-webhook         (called by Stripe, signature checked)       -> plans and top-up credits
//
// Rules this file keeps:
//   * Card details never touch this server or the website. People type them on Stripe's own pages.
//   * Only the webhook turns a plan on, and only after Stripe's signature checks out. The browser is never trusted.
//   * The plan itself is still written by entitlements.setPlan (the same door your admin command uses).
//   * No Stripe key, token, or request body is ever logged.
//   * Not configured (no STRIPE_SECRET_KEY)? Every route answers 501 {error:'billing_off'} and the dashboard falls back.
import crypto from 'node:crypto';
import express from 'express';

export const TOPUP_CREDITS = 500;
const PLAN_KEYS = ['starter', 'pro', 'business'];
const LIVE_STATUSES = ['active', 'trialing', 'past_due'];
const DEAD_STATUSES = ['canceled', 'unpaid', 'incomplete_expired'];
const SIG_TOLERANCE_S = 300;
const PLAN_LABEL = { starter: 'Starter ($19/mo)', pro: 'Pro ($49/mo)', business: 'Business ($99/mo)' };

// Sends a plain-text message to one Telegram chat (the owner). Use it as the `notify` option if the bot has no sender of its own.
export function telegramNotifier({ token, chatId, fetchImpl = globalThis.fetch } = {}) {
  return async (text) => {
    if (!token || !chatId) return;
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: String(chatId), text: String(text).slice(0, 3500), disable_web_page_preview: true }), signal: ctl.signal });
      if (!r.ok) throw new Error(`telegram ${r.status}`);
    } finally { clearTimeout(timer); }
  };
}

// ---- helpers (exported so they can be tested) ------------------------------------------------------
function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (x && typeof x === 'object' ? flatten(x, `${key}[${i}]`, out) : out.push([`${key}[${i}]`, String(x)])));
    else if (typeof v === 'object') flatten(v, key, out);
    else out.push([key, String(v)]);
  }
  return out;
}
export const formEncode = (obj) => flatten(obj, '', []).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

// Stripe-Signature: t=timestamp,v1=hexhmac[,v1=...]   (HMAC-SHA256 of `${t}.${rawBody}` with the webhook secret)
export function verifySignature(rawBody, header, secret, nowMs = Date.now()) {
  if (!secret || !header || !Buffer.isBuffer(rawBody)) return false;
  let t = null; const sigs = [];
  for (const part of String(header).split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === 't') t = v; else if (k === 'v1') sigs.push(v);
  }
  if (!t || !/^\d{1,12}$/.test(t) || !sigs.length) return false;
  if (Math.abs(nowMs / 1000 - Number(t)) > SIG_TOLERANCE_S) return false;
  const want = crypto.createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  return sigs.some((s) => {
    if (!/^[0-9a-f]{64}$/i.test(s)) return false;
    return crypto.timingSafeEqual(want, Buffer.from(s, 'hex'));
  });
}

const periodEndOf = (sub) => {
  const s = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end; // newer Stripe versions keep it on the item
  return Number.isFinite(Number(s)) && Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null;
};

export function originsFromEnv(env = process.env) {
  return [...String(env.WEB_ORIGINS || '').split(','), env.SITE_URL || '']
    .map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

// ---- the module --------------------------------------------------------------------------------------
export function mountBilling(app, {
  auth, entitlements, getTenant,
  supabaseUrl, supabaseKey,
  env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(),
  origins = originsFromEnv(env), log = () => {}, notify = null,
} = {}) {
  const secretKey = String(env.STRIPE_SECRET_KEY || '').trim();
  const webhookSecret = String(env.STRIPE_WEBHOOK_SECRET || '').trim();
  const prices = { starter: env.STRIPE_PRICE_STARTER, pro: env.STRIPE_PRICE_PRO, business: env.STRIPE_PRICE_BUSINESS, topup: env.STRIPE_PRICE_TOPUP };
  for (const k of Object.keys(prices)) prices[k] = String(prices[k] || '').trim();
  const planByPrice = Object.fromEntries(PLAN_KEYS.filter((k) => prices[k]).map((k) => [prices[k], k]));
  const site = String(env.PUBLIC_SITE_URL || env.SITE_URL || 'https://www.co-optech.com').trim().replace(/\/+$/, '');
  const sbBase = String(supabaseUrl || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  const sbKey = String(supabaseKey || '').trim();
  const enabled = Boolean(secretKey && sbBase && sbKey && auth && entitlements && prices.starter);

  // -- small clients
  const timed = async (url, opts, ms = 10000) => {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), ms);
    try { return await fetchImpl(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(timer); }
  };
  async function stripe(method, path, params) {
    const url = `https://api.stripe.com/v1/${path}${method === 'GET' && params ? `?${formEncode(params)}` : ''}`;
    const res = await timed(url, {
      method,
      headers: { authorization: `Bearer ${secretKey}`, ...(method === 'GET' ? {} : { 'content-type': 'application/x-www-form-urlencoded' }) },
      body: method === 'GET' ? undefined : formEncode(params || {}),
    });
    let body = null; try { body = await res.json(); } catch { /* not json */ }
    if (!res.ok) {
      const er = body?.error || {}; // Stripe's own reason (never contains keys); shortened so a log line stays small
      const why = [er.code, er.param ? `param ${er.param}` : '', er.message ? String(er.message).replace(/\s+/g, ' ').slice(0, 200) : ''].filter(Boolean).join(' - ');
      const e = new Error(`stripe ${method} ${path.split('/')[0]} failed (${res.status}${why ? `: ${why}` : ''})`); e.status = res.status; throw e;
    }
    return body;
  }
  const sbHeaders = (prefer) => ({ 'content-type': 'application/json', apikey: sbKey, ...(sbKey.startsWith('eyJ') ? { authorization: `Bearer ${sbKey}` } : {}), ...(prefer ? { Prefer: prefer } : {}) });
  const sb = (path, opts) => timed(`${sbBase}/rest/v1/${path}`, opts, 8000);
  const eq = (v) => encodeURIComponent(String(v));

  // -- alerts to the owner (never allowed to break a webhook; sent in the background)
  const testTag = secretKey.startsWith('sk_live') ? '' : '[TEST] ';
  function alert(text) {
    if (typeof notify !== 'function') return Promise.resolve();
    return Promise.resolve().then(() => notify(`${testTag}${text}`)).catch((e) => log(`[stripe] owner alert failed: ${e?.message || 'Error'}`));
  }
  async function describe(chatId, customerId, email) {
    let mail = email || '';
    if (!mail && customerId) { try { mail = (await stripe('GET', `customers/${encodeURIComponent(customerId)}`))?.email || ''; } catch { /* best effort */ } }
    return `${mail ? `${mail}\n` : ''}chat ${chatId}`;
  }
  const chain = new Map(); // one webhook at a time per customer, so "who changed what" is read correctly
  function serial(key, fn) {
    const run = (chain.get(key) || Promise.resolve()).catch(() => {}).then(fn);
    chain.set(key, run);
    run.then(() => {}, () => {}).then(() => { if (chain.get(key) === run) chain.delete(key); });
    return run;
  }

  // -- tables: billing_accounts (chat_id -> Stripe customer/subscription) and stripe_events (seen webhook ids)
  async function getAccount(chatId) {
    const res = await sb(`billing_accounts?chat_id=eq.${eq(chatId)}&select=chat_id,stripe_customer_id,stripe_subscription_id,status,plan,cancel_at_end&limit=1`, { method: 'GET', headers: sbHeaders() });
    if (!res.ok) throw new Error(`account lookup failed (${res.status})`);
    const rows = await res.json(); return Array.isArray(rows) ? rows[0] || null : null;
  }
  async function chatByCustomer(customerId) {
    const res = await sb(`billing_accounts?stripe_customer_id=eq.${eq(customerId)}&select=chat_id&limit=1`, { method: 'GET', headers: sbHeaders() });
    if (!res.ok) throw new Error(`customer lookup failed (${res.status})`);
    const rows = await res.json(); return Array.isArray(rows) && rows[0] ? String(rows[0].chat_id) : null;
  }
  async function saveAccount(row) {
    const res = await sb('billing_accounts?on_conflict=chat_id', { method: 'POST', headers: sbHeaders('resolution=merge-duplicates,return=minimal'), body: JSON.stringify({ ...row, updated_at: new Date(now()).toISOString() }) });
    if (!res.ok) throw new Error(`account save failed (${res.status})`);
  }
  async function eventSeen(id) {
    const res = await sb(`stripe_events?id=eq.${eq(id)}&select=id&limit=1`, { method: 'GET', headers: sbHeaders() });
    if (!res.ok) throw new Error(`event lookup failed (${res.status})`);
    const rows = await res.json(); return Array.isArray(rows) && rows.length > 0;
  }
  async function markSeen(evt) {
    const res = await sb('stripe_events?on_conflict=id', { method: 'POST', headers: sbHeaders('resolution=ignore-duplicates,return=minimal'), body: JSON.stringify({ id: evt.id, type: evt.type }) });
    if (!res.ok) throw new Error(`event save failed (${res.status})`);
  }

  // -- turning Stripe facts into plans and credits
  async function syncSubscription(sub, { chatId: hint = null, anchor = false } = {}) {
    const chatId = hint || sub?.metadata?.chat_id || (sub?.customer ? await chatByCustomer(sub.customer) : null);
    if (!chatId) { log('[stripe] subscription with no known customer, skipped'); return; }
    const priceId = sub?.items?.data?.[0]?.price?.id;
    const plan = planByPrice[priceId];
    if (!plan) { log('[stripe] subscription on an unknown price, skipped'); return; }
    const status = String(sub.status || '');
    if (status === 'incomplete') return; // not paid yet
    let endsAt = periodEndOf(sub);
    if (DEAD_STATUSES.includes(status)) endsAt = new Date(now()).toISOString(); // over: the plan lapses (the normal grace days apply)
    if (!endsAt) throw new Error('subscription has no period end');
    return serial(String(chatId), async () => {
      const prev = await getAccount(String(chatId)); // what we knew before this event
      const r = await entitlements.setPlan(String(chatId), { plan, endsAt, ...(anchor ? { anchor: new Date(now()).toISOString().slice(0, 10) } : {}) });
      if (r && r.error) throw new Error(`setPlan failed (${r.error})`);
      // a scheduled cancel shows up as cancel_at_period_end or as a cancel_at date, depending on the Stripe version
      const cancelFlag = !DEAD_STATUSES.includes(status) && Boolean(sub.cancel_at_period_end || sub.cancel_at);
      const prevFlag = Boolean(prev?.cancel_at_end);
      await saveAccount({ chat_id: String(chatId), stripe_customer_id: sub.customer || null, stripe_subscription_id: sub.id, status, plan, current_period_end: periodEndOf(sub), cancel_at_end: cancelFlag });
      log(`[stripe] ${chatId} -> ${plan} (${status})`);
      // tell the owner only when something actually changed (Stripe sends several events for one purchase)
      const wasLive = Boolean(prev) && LIVE_STATUSES.includes(prev.status);
      const isLive = LIVE_STATUSES.includes(status);
      let msg = null;
      if (isLive && !wasLive) msg = `New subscriber: ${PLAN_LABEL[plan]}`;
      else if (DEAD_STATUSES.includes(status) && wasLive) msg = `Subscription ended: ${PLAN_LABEL[prev.plan] || prev.plan || plan}`;
      else if (status === 'past_due' && prev?.status === 'active') msg = `Payment problem, subscription is past due: ${PLAN_LABEL[plan]}`;
      else if (isLive && wasLive && prev.plan && prev.plan !== plan) msg = `Plan change: ${prev.plan} -> ${plan}`;
      else if (isLive && cancelFlag && !prevFlag) msg = `Cancel scheduled: ${PLAN_LABEL[plan]} ends ${endsAt.slice(0, 10)}`;
      else if (isLive && !cancelFlag && prevFlag) msg = `Cancellation undone: ${PLAN_LABEL[plan]} continues`;
      if (msg) void describe(String(chatId), sub.customer).then((who) => alert(`${msg}\n${who}`));
    });
  }
  async function addTopup(chatId, sessionId, email) {
    const ref = `stripe:${sessionId}`;
    const seen = await sb(`credit_ledger?ref=eq.${eq(ref)}&select=ref&limit=1`, { method: 'GET', headers: sbHeaders() });
    if (!seen.ok) throw new Error(`ledger lookup failed (${seen.status})`);
    const rows = await seen.json(); if (Array.isArray(rows) && rows.length) return; // already added
    const ent = await entitlements.get(getTenant?.(chatId) || { chatId: String(chatId) });
    if (!ent?.cycleStart) throw new Error('no billing cycle for top-up');
    const res = await sb('credit_ledger', { method: 'POST', headers: sbHeaders('return=minimal'), body: JSON.stringify({ chat_id: String(chatId), cycle: ent.cycleStart, delta: TOPUP_CREDITS, reason: 'topup', ref }) });
    if (!res.ok && res.status !== 409) throw new Error(`top-up save failed (${res.status})`);
    log(`[stripe] ${chatId} +${TOPUP_CREDITS} credits`);
    void describe(chatId, null, email).then((who) => alert(`Top-up: +${TOPUP_CREDITS} credits ($10)\n${who}`));
  }
  async function handleEvent(evt) {
    const o = evt?.data?.object || {};
    switch (evt.type) {
      case 'checkout.session.completed': {
        const chatId = o.client_reference_id || o.metadata?.chat_id;
        if (!chatId) return;
        if (o.mode === 'subscription' && o.subscription) {
          const sub = await stripe('GET', `subscriptions/${encodeURIComponent(o.subscription)}`);
          await syncSubscription(sub, { chatId: String(chatId), anchor: true });
        } else if (o.mode === 'payment' && o.metadata?.kind === 'topup' && o.payment_status === 'paid') {
          await addTopup(String(chatId), o.id, o.customer_details?.email || o.customer_email);
        }
        return;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        return syncSubscription(o);
      case 'invoice.paid': {
        const subId = o.subscription || o.parent?.subscription_details?.subscription;
        if (!subId) return;
        return syncSubscription(await stripe('GET', `subscriptions/${encodeURIComponent(subId)}`));
      }
      case 'invoice.payment_failed': {
        log('[stripe] a payment failed (Stripe will retry)');
        let chatId = null; try { chatId = o.customer ? await chatByCustomer(o.customer) : null; } catch { /* alert still goes out */ }
        const amt = Number.isFinite(Number(o.amount_due)) ? `$${(Number(o.amount_due) / 100).toFixed(2)}` : 'a payment';
        const tries = o.attempt_count ? `, attempt ${o.attempt_count}` : '';
        void alert(`Payment failed: ${amt}${tries}. Stripe will retry.\n${o.customer_email ? `${o.customer_email}\n` : ''}chat ${chatId || 'unknown'}`);
        return;
      }
      default: return;
    }
  }

  // -- web routes (same login check as /web/chat)
  const cors = (req, res, next) => {
    const origin = req.get('origin');
    if (origin && origins.includes(origin)) {
      res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type, ngrok-skip-browser-warning', 'Access-Control-Max-Age': '600', Vary: 'Origin' });
    } else if (origin) return res.status(403).json({ error: 'origin not allowed' });
    next();
  };
  const hits = new Map();
  const limited = (key, max = 12, windowMs = 60000) => {
    const t = now(); const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    arr.push(t); hits.set(key, arr); if (hits.size > 2000) hits.clear();
    return arr.length > max;
  };
  const off = (res) => res.status(501).json({ error: 'billing_off' });
  async function who(req, res) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
    const v = await auth.verify(m ? m[1] : '');
    if (v.error === 'unauthorized') { res.status(401).json({ error: 'sign in again' }); return null; }
    if (v.error) { res.status(503).json({ error: 'try again in a moment' }); return null; }
    if (limited(`u:${v.userId}`)) { res.status(429).json({ error: 'too many requests' }); return null; }
    const link = await auth.chatFor(v.userId);
    if (link.error === 'unavailable') { res.status(503).json({ error: 'try again in a moment' }); return null; }
    if (!link.chatId) { res.status(409).json({ error: 'not_linked', message: 'Link this login to your agent first (see Get started).' }); return null; }
    return { chatId: String(link.chatId) };
  }

  app.options(['/web/billing/checkout', '/web/billing/portal'], cors, (_req, res) => res.status(204).end());

  app.post('/web/billing/checkout', cors, (req, res, next) => (limited(`ip:${req.ip || 'x'}`, 60) ? res.status(429).json({ error: 'too many requests' }) : next()), express.json({ limit: '4kb' }), async (req, res) => {
    if (!enabled) return off(res);
    try {
      const me = await who(req, res); if (!me) return;
      const plan = String(req.body?.plan || '');
      if (!prices[plan]) return res.status(400).json({ error: 'unknown plan' });
      const acct = await getAccount(me.chatId);
      const params = {
        client_reference_id: me.chatId, line_items: [{ price: prices[plan], quantity: 1 }],
        success_url: `${site}/agent/dashboard.html?checkout=success#settings`,
        cancel_url: `${site}/agent/dashboard.html?checkout=cancelled#upgrade`,
        metadata: { chat_id: me.chatId, kind: plan },
        ...(acct?.stripe_customer_id ? { customer: acct.stripe_customer_id } : {}),
      };
      if (plan === 'topup') {
        const ent = await entitlements.get(getTenant?.(me.chatId) || { chatId: me.chatId });
        if (!(PLAN_KEYS.includes(ent?.planKey) && ent.state === 'active')) return res.status(409).json({ error: 'no_plan', message: 'Top-ups are for paid plans. Pick a plan first.' });
        params.mode = 'payment';
        params.payment_intent_data = { metadata: { chat_id: me.chatId, kind: 'topup' } };
      } else {
        if (acct?.stripe_subscription_id && LIVE_STATUSES.includes(acct.status)) return res.status(409).json({ error: 'already_subscribed', message: 'You already have a subscription. Use Manage billing to change your plan.' });
        params.mode = 'subscription';
        params.allow_promotion_codes = true;
        params.subscription_data = { metadata: { chat_id: me.chatId, plan } };
      }
      const session = await stripe('POST', 'checkout/sessions', params);
      if (!session?.url) throw new Error('no checkout url');
      res.json({ url: session.url });
    } catch (err) {
      console.error('[billing] checkout failed:', err?.message || 'Error');
      res.status(500).json({ error: 'something went wrong' });
    }
  });

  app.post('/web/billing/portal', cors, (req, res, next) => (limited(`ip:${req.ip || 'x'}`, 60) ? res.status(429).json({ error: 'too many requests' }) : next()), express.json({ limit: '4kb' }), async (req, res) => {
    if (!enabled) return off(res);
    try {
      const me = await who(req, res); if (!me) return;
      const acct = await getAccount(me.chatId);
      if (!acct?.stripe_customer_id) return res.status(409).json({ error: 'no_billing', message: 'There’s no card on file yet. Pick a plan on the Upgrade page first.' });
      const s = await stripe('POST', 'billing_portal/sessions', { customer: acct.stripe_customer_id, return_url: `${site}/agent/dashboard.html#settings` });
      if (!s?.url) throw new Error('no portal url');
      res.json({ url: s.url });
    } catch (err) {
      console.error('[billing] portal failed:', err?.message || 'Error');
      res.status(500).json({ error: 'something went wrong' });
    }
  });

  // Stripe calls this. It needs the raw body (the signature covers the exact bytes), so mount this BEFORE any global express.json().
  app.post('/stripe-webhook', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
    if (!enabled || !webhookSecret) return off(res);
    if (!verifySignature(req.body, req.get('stripe-signature'), webhookSecret, now())) return res.status(400).json({ error: 'bad signature' });
    let evt;
    try { evt = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: 'bad body' }); }
    if (!evt || typeof evt.id !== 'string' || typeof evt.type !== 'string') return res.status(400).json({ error: 'bad event' });
    try {
      if (await eventSeen(evt.id)) return res.json({ received: true, duplicate: true });
      await handleEvent(evt);
      await markSeen(evt);
      res.json({ received: true });
    } catch (err) {
      console.error('[stripe] could not process', evt.type, '-', err?.message || 'Error'); // Stripe will try again
      res.status(500).json({ error: 'retry' });
    }
  });

  log(`Billing: ${enabled ? `on (${secretKey.startsWith('sk_live') ? 'LIVE' : 'test'} mode${webhookSecret ? '' : ', webhook secret missing'})` : 'OFF (no Stripe settings)'}.`);
  return { enabled };
}
