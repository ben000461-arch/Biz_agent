// entitlement.js — "what is this customer allowed to do right now?"
//
// One question, one answer, used by Telegram AND the website chat so they can never disagree:
//   const ent = await entitlements.get(tenant);
//   ent.state   'admin' | 'trial' | 'active' | 'pilot' | 'frozen' | 'limited'
//   ent.canUse  true unless frozen
//   ent.plan    the plan table entry from plans.js (models, caps, credits)
//
// The plan lives in Supabase (table tenant_plans) so the website can show the same thing. The bot reads it
// with the service key, keeps the answer for a minute, and never throws: if Supabase can't be reached and
// nothing is cached, it serves "limited" mode (cheap models, small caps) instead of failing or overspending.

import {
  PLANS, ADMIN, SAFE_MODE, SETTABLE_PLANS, TRIAL_DAYS, PAID_GRACE_DAYS, TRIAL_REMINDER_DAYS, cycleStart,
} from './plans.js';

const CHAT_ID_RE = /^-?\d{1,20}$/;
const DAY = 24 * 60 * 60 * 1000;

export function createEntitlements({
  url, key, fetchImpl = globalThis.fetch, now = () => Date.now(), cacheMs = 60_000, failCacheMs = 10_000, timeoutMs = 5000,
} = {}) {
  const base = String(url || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  const secret = String(key || '').trim();
  const enabled = Boolean(base && secret);
  const cache = new Map(); // chatId -> { at, ent, ttl }

  const headers = (prefer) => {
    const h = { 'content-type': 'application/json', apikey: secret };
    if (secret.startsWith('eyJ')) h.authorization = `Bearer ${secret}`; // only old-style JWT keys go here too
    if (prefer) h.Prefer = prefer;
    return h;
  };

  async function call(path, opts) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try { return await fetchImpl(`${base}/rest/v1/${path}`, { ...opts, signal: ctl.signal }); } finally { clearTimeout(timer); }
  }

  // ---- turning a database row into an answer ------------------------------------------------------
  function daysBetween(a, b) { return Math.floor((b - a) / DAY); }

  // A frozen answer never carries a plan, so no caller can accidentally run a model for a frozen customer.
  function derive(row, at) {
    const r = derive1(row, at);
    return r.canUse ? r : { ...r, plan: null };
  }

  function derive1(row, at) {
    const t = at;
    const planKey = String(row.plan || '');
    const ends = row.ends_at ? new Date(row.ends_at).getTime() : null;
    const base = {
      planKey, endsAt: ends ? new Date(ends).toISOString() : null,
      cycleStart: cycleStart(row.cycle_anchor || row.created_at || new Date(t).toISOString(), new Date(t)),
      createdAt: row.created_at || null,
    };
    if (planKey === 'frozen') return { ...base, state: 'frozen', canUse: false, reason: 'manual', plan: null };
    if (!PLANS[planKey]) return { ...base, state: 'frozen', canUse: false, reason: 'unknown_plan', plan: null }; // bad data fails closed

    const plan = PLANS[planKey];
    if (planKey === 'trial') {
      const over = ends != null && t >= ends;
      const started = row.created_at ? new Date(row.created_at).getTime() : (ends ? ends - TRIAL_DAYS * DAY : t);
      return {
        ...base, plan, state: over ? 'frozen' : 'trial', canUse: !over, reason: over ? 'trial_ended' : null,
        daysLeft: ends == null ? null : Math.max(0, Math.ceil((ends - t) / DAY)), trialDay: Math.max(0, daysBetween(started, t)),
      };
    }
    if (planKey === 'pilot') {
      const over = ends != null && t >= ends;
      return { ...base, plan, state: over ? 'frozen' : 'pilot', canUse: !over, reason: over ? 'pilot_ended' : null };
    }
    // paid plans: an end date in the past (plus a short grace) means the payment lapsed
    const lapsed = ends != null && t >= ends + PAID_GRACE_DAYS * DAY;
    return { ...base, plan, state: lapsed ? 'frozen' : 'active', canUse: !lapsed, reason: lapsed ? 'lapsed' : null };
  }

  const adminEnt = () => ({ state: 'admin', canUse: true, planKey: 'admin', plan: ADMIN, reason: null, endsAt: null, cycleStart: null });
  const limitedEnt = () => ({ state: 'limited', canUse: true, planKey: 'limited', plan: SAFE_MODE, reason: 'plan_unavailable', endsAt: null, cycleStart: null });

  async function fetchRow(chatId) {
    const res = await call(`tenant_plans?chat_id=eq.${encodeURIComponent(chatId)}&select=chat_id,plan,ends_at,cycle_anchor,last_reminder,created_at&limit=1`, { method: 'GET', headers: headers() });
    if (!res.ok) throw new Error(`plan lookup failed (${res.status})`);
    const rows = await res.json();
    return Array.isArray(rows) ? rows[0] || null : null;
  }

  // A chat we've never seen starts a free trial now. "ignore-duplicates" means two messages arriving together
  // can't create two rows or reset a trial.
  async function createTrial(chatId) {
    const t = now();
    const row = { chat_id: chatId, plan: 'trial', ends_at: new Date(t + TRIAL_DAYS * DAY).toISOString(), cycle_anchor: new Date(t).toISOString().slice(0, 10), created_at: new Date(t).toISOString() };
    const res = await call('tenant_plans?on_conflict=chat_id', { method: 'POST', headers: headers('resolution=ignore-duplicates,return=representation'), body: JSON.stringify(row) });
    if (!res.ok) throw new Error(`plan create failed (${res.status})`);
    const rows = await res.json();
    return Array.isArray(rows) && rows[0] ? rows[0] : (await fetchRow(chatId)) || row; // lost the race: read the winner's row
  }

  // ---- public API -----------------------------------------------------------------------------------
  // tenant: the bot's record for this chat ({ chatId, isAdmin, ... }).
  async function get(tenant) {
    if (tenant?.isAdmin) return adminEnt();
    const chatId = String(tenant?.chatId ?? '');
    if (!CHAT_ID_RE.test(chatId)) return { state: 'frozen', canUse: false, planKey: 'unknown', plan: null, reason: 'unknown_chat', endsAt: null, cycleStart: null };
    if (!enabled) return limitedEnt();

    const hit = cache.get(chatId);
    if (hit && now() - hit.at < hit.ttl) return hit.ent;

    try {
      let row = await fetchRow(chatId);
      if (!row) row = await createTrial(chatId);
      const ent = { ...derive(row, now()), lastReminder: row.last_reminder ?? null };
      cache.set(chatId, { at: now(), ent, ttl: cacheMs });
      return ent;
    } catch {
      if (hit) return { ...hit.ent, stale: true }; // keep serving the last known answer while Supabase is down
      const ent = limitedEnt();
      cache.set(chatId, { at: now(), ent, ttl: failCacheMs });
      return ent;
    }
  }

  // Forget the cached answer (after an admin changes a plan, so it applies straight away).
  function invalidate(chatId) { cache.delete(String(chatId)); }

  // Admin change: set a customer's plan. -> { ok: true } | { error: 'bad-plan' | 'bad-chat' | 'unavailable' | 'failed' }
  async function setPlan(chatId, { plan, endsAt = null, anchor } = {}) {
    const id = String(chatId ?? '');
    if (!CHAT_ID_RE.test(id)) return { error: 'bad-chat' };
    if (!SETTABLE_PLANS.includes(plan)) return { error: 'bad-plan' };
    if (!enabled) return { error: 'unavailable' };
    const row = { chat_id: id, plan, ends_at: endsAt ? new Date(endsAt).toISOString() : null, updated_at: new Date(now()).toISOString() };
    if (anchor) row.cycle_anchor = String(anchor).slice(0, 10);
    try {
      const res = await call('tenant_plans?on_conflict=chat_id', { method: 'POST', headers: headers('resolution=merge-duplicates,return=minimal'), body: JSON.stringify(row) });
      if (!res.ok) return { error: 'failed' };
      invalidate(id);
      return { ok: true };
    } catch {
      return { error: 'unavailable' };
    }
  }

  // Which trial reminder (day 25 / 28 / 30) is due and not yet sent? null if none.
  function reminderDue(ent) {
    if (!ent || ent.state !== 'trial' || ent.trialDay == null) return null;
    const due = TRIAL_REMINDER_DAYS.filter((d) => ent.trialDay >= d && d > (ent.lastReminder ?? 0));
    return due.length ? due[due.length - 1] : null;
  }

  async function markReminder(chatId, day) {
    const id = String(chatId ?? '');
    if (!CHAT_ID_RE.test(id) || !TRIAL_REMINDER_DAYS.includes(day) || !enabled) return { error: 'failed' };
    try {
      const res = await call(`tenant_plans?chat_id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: headers('return=minimal'), body: JSON.stringify({ last_reminder: day }) });
      if (res.ok) invalidate(id);
      return res.ok ? { ok: true } : { error: 'failed' };
    } catch {
      return { error: 'unavailable' };
    }
  }

  return { enabled, get, invalidate, setPlan, reminderDue, markReminder, derive };
}

// The fixed message a frozen customer sees in Telegram. Written in code on purpose: no model call, no cost,
// and it can never say anything we didn't mean. Only promises things that exist today.
export function frozenMessage(ent, { siteUrl = '', contact = 'cooptech126@gmail.com' } = {}) {
  const site = siteUrl ? `\n\nYour dashboard, logs and settings are still open: ${siteUrl}dashboard.html` : '';
  const how = `\n\nTo keep going, email ${contact} and we'll switch your agent back on.`;
  switch (ent?.reason) {
    case 'trial_ended':
      return `Your free trial has ended, so I've paused your agent. Your data is safe and nothing was deleted.${how}${site}`;
    case 'pilot_ended':
      return `Your pilot period has ended, so I've paused your agent. Your data is safe and nothing was deleted.${how}${site}`;
    case 'lapsed':
      return `Your plan's payment period has ended, so I've paused your agent. Your data is safe and nothing was deleted.${how}${site}`;
    default:
      return `Your agent is paused right now. Your data is safe.${how}${site}`;
  }
}

// The nudge the bot sends at trial days 25, 28 and 30. Also fixed text.
export function trialReminderMessage(ent, { contact = 'cooptech126@gmail.com' } = {}) {
  const left = ent?.daysLeft;
  const when = left == null ? 'soon' : left <= 0 ? 'today' : left === 1 ? 'tomorrow' : `in ${left} days`;
  return `Heads up: your free trial ends ${when}. After that I'll pause your agent until you choose a plan. Email ${contact} to keep it running.`;
}
