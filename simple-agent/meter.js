// meter.js — the credit meter: what has this customer spent, and may they do this right now?
//
// Three kinds of limit, all from plans.js:
//   credits   monthly allowance in the credit_ledger table (Starter/Pro/Business/Pilot). Out of credits:
//             chat drops to the free small model, actions pause until the cycle resets.
//   daily     no plan may spend more than 25% of its monthly credits in one day; trial/Starter/limited mode
//             also have small per-day action/chat counts (kept in memory, so a restart resets them).
//   per-minute  a burst limit per chat.
//
// Decisions (decide) and messages are plain functions with no network, so they are easy to test. The
// ledger reads/writes go through createMeter, which never throws: if Supabase is down it keeps counting in
// memory and falls back to cheap, small limits instead of failing or overspending.

import { CREDIT_COSTS, DAILY_FRACTION, TOPUP, WARN_AT, SAFE_MODE, dailyCreditCeiling, chatTierFor, topupAllowed, cycleStart } from './plans.js';

const CHAT_ID_RE = /^-?\d{1,20}$/;
const DAY = 86400000;
const utcDate = (t) => new Date(t).toISOString().slice(0, 10);

// Actions that cost us nothing to run (pure code, no outside service) don't spend credits.
// Everything else that does real work costs CREDIT_COSTS.action. Edit this list to change what is free.
export const CREDIT_FREE_ACTIONS = new Set([
  'chat', 'add', 'multiply', 'add_note', 'list_notes', 'disconnect', 'remove_model', 'cloud_ok', 'push_change', 'agent_delete',
]);
export const actionCosts = (action) => !CREDIT_FREE_ACTIONS.has(action);

// When does the next cycle start? (for "resets on …" messages)
export function nextReset(anchor, cycle) {
  if (!cycle) return null;
  const probe = new Date(new Date(`${cycle}T00:00:00Z`).getTime() + 32 * DAY);
  return cycleStart(anchor || cycle, probe);
}

// Which warning line did this spend newly cross? 1 (100%), 0.8 (80%) or null.
export function crossing(spentBefore, spentAfter, total) {
  if (!total || total <= 0) return null;
  const hit = [...WARN_AT].reverse().find((w) => spentBefore / total < w && spentAfter / total >= w);
  return hit ?? null;
}

// May this happen right now? kind = 'action' | 'chat'.
//   plan   the plan table entry          state  from meter.state() ({known:false} if the ledger is unreachable)
//   counts { actions, chats } done today (memory)
// -> { ok: true, tierOverride? } | { ok: false, reason }
export function decide(plan, kind, state, counts = {}) {
  if (!plan) return { ok: true };
  const daily = plan.daily || {};
  const metered = plan.credits != null;
  if (kind === 'action') {
    if (daily.actions != null && (counts.actions || 0) >= daily.actions) return { ok: false, reason: 'daily_actions' };
    if (!metered) return { ok: true };
    if (!state?.known) {
      // can't read the ledger: allow a few, so a Supabase outage doesn't stop the business or open the tap
      return (counts.actions || 0) >= SAFE_MODE.daily.actions ? { ok: false, reason: 'daily_actions' } : { ok: true };
    }
    if (state.left < CREDIT_COSTS.action) return { ok: false, reason: 'out_of_credits' };
    if (state.todaySpent + CREDIT_COSTS.action > dailyCreditCeiling(plan)) return { ok: false, reason: 'daily_ceiling' };
    return { ok: true };
  }
  // chat
  if (daily.chats != null && (counts.chats || 0) >= daily.chats) return { ok: false, reason: 'daily_chats' };
  if (!metered) return { ok: true };
  if (!state?.known) return { ok: true, tierOverride: 'small' };
  let tier = chatTierFor(plan, state.left);
  if (tier === plan.models.chat && CREDIT_COSTS.chat[tier] > 0 && state.todaySpent + CREDIT_COSTS.chat[tier] > dailyCreditCeiling(plan)) tier = 'small';
  return tier !== plan.models.chat ? { ok: true, tierOverride: tier } : { ok: true };
}

// ---- fixed messages (code-written: no model call, nothing promised that doesn't exist) --------------------
const fmt = (n) => Number(n).toLocaleString('en-US');
const prettyDate = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }) : 'your next billing date');

export function blockMessage(reason, { reset = null, contact = 'cooptech126@gmail.com' } = {}) {
  switch (reason) {
    case 'out_of_credits':
      return `You've used all of this month's credits, so I've paused actions until they reset on ${prettyDate(reset)}. I can still chat with you. To add more now, email ${contact}.`;
    case 'daily_ceiling':
      return `You've hit today's usage limit (it keeps the month's credits from running out in one day). It resets tomorrow, and chat still works. Need more today? Email ${contact}.`;
    case 'daily_actions':
      return `You've reached today's limit for actions. It resets tomorrow, and chat still works. Need more? Email ${contact}.`;
    case 'daily_chats':
      return `You've reached today's chat limit. It resets tomorrow. Need more? Email ${contact}.`;
    default:
      return 'I need to pause for a moment. Please try again shortly.';
  }
}
export const rateLimitMessage = () => "You're sending messages very quickly. Give me a moment and try again.";

export function warningMessage(level, state, { reset = null, contact = 'cooptech126@gmail.com' } = {}) {
  if (level >= 1) return `You've used all of this month's credits. Actions are paused until ${prettyDate(reset)}, and chat keeps working. To add more, email ${contact}.`;
  return `Heads up: you've used ${Math.round(WARN_AT[0] * 100)}% of this month's credits (${fmt(Math.max(0, state.left))} left). They reset on ${prettyDate(reset)}.`;
}

export function usageMessage(ent, state, { reset = null } = {}) {
  const label = ent?.plan?.label || 'your plan';
  if (!ent?.plan || ent.plan.credits == null) return `Plan: ${label}. This plan isn't measured in credits.${ent?.daysLeft != null ? ` ${ent.daysLeft} day${ent.daysLeft === 1 ? '' : 's'} left in your trial.` : ''}`;
  if (!state?.known) return `Plan: ${label}. I can't read your credit balance right now, so try again in a minute.`;
  const used = state.total - state.left;
  const pct = state.total ? Math.round((used / state.total) * 100) : 0;
  return `Plan: ${label}. Credits this month: ${fmt(used)} of ${fmt(state.total)} used (${pct}%), ${fmt(Math.max(0, state.left))} left. Resets on ${prettyDate(reset)}. Today: ${fmt(state.todaySpent)} of ${fmt(dailyCreditCeiling(ent.plan))} daily limit.`;
}

// ---- the meter itself ---------------------------------------------------------------------------------
export function createMeter({ url, key, fetchImpl = globalThis.fetch, now = () => Date.now(), cacheMs = 20_000, timeoutMs = 5000 } = {}) {
  const base = String(url || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  const secret = String(key || '').trim();
  const enabled = Boolean(base && secret);
  const cache = new Map();   // chatId -> { at, cycle, state }
  const counters = new Map(); // `${chatId}:${utcDate}` -> { actions, chats }
  const windows = new Map(); // chatId -> { stamps: [], noticeAt }

  const headers = (prefer) => {
    const h = { 'content-type': 'application/json', apikey: secret };
    if (secret.startsWith('eyJ')) h.authorization = `Bearer ${secret}`;
    if (prefer) h.Prefer = prefer;
    return h;
  };
  async function call(path, opts) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try { return await fetchImpl(`${base}/rest/v1/${path}`, { ...opts, signal: ctl.signal }); } finally { clearTimeout(timer); }
  }

  async function fetchRows(chatId, cycle) {
    const res = await call(`credit_ledger?chat_id=eq.${encodeURIComponent(chatId)}&cycle=eq.${cycle}&select=ts,delta,reason&limit=5000`, { method: 'GET', headers: headers() });
    if (!res.ok) throw new Error(`ledger read failed (${res.status})`);
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
  }
  async function insert(row) {
    const res = await call('credit_ledger', { method: 'POST', headers: headers('return=minimal'), body: JSON.stringify(row) });
    return res.ok || res.status === 409; // 409 = the one-grant-per-cycle rule said "already there", which is fine
  }

  function summarize(rows, t) {
    const midnight = new Date(`${utcDate(t)}T00:00:00Z`).getTime();
    let left = 0, total = 0, spent = 0, todaySpent = 0, topupCount = 0, hasGrant = false;
    for (const r of rows) {
      const d = Number(r.delta) || 0;
      left += d;
      if (r.reason === 'spend') { spent += -d; if (new Date(r.ts).getTime() >= midnight) todaySpent += -d; }
      else if (r.reason === 'refund') { spent -= d; if (new Date(r.ts).getTime() >= midnight) todaySpent -= d; }
      else { total += d; if (r.reason === 'topup') topupCount++; if (r.reason === 'grant') hasGrant = true; }
    }
    return { known: true, left, total, spent, todaySpent: Math.max(0, todaySpent), topupCount, hasGrant };
  }

  // The balance for this cycle. Creates the monthly grant the first time it is needed.
  async function state(chatId, ent) {
    const id = String(chatId ?? '');
    const plan = ent?.plan;
    if (!plan || plan.credits == null) return { known: true, metered: false };
    if (!enabled || !CHAT_ID_RE.test(id) || !ent.cycleStart) return { known: false, metered: true };
    const hit = cache.get(id);
    if (hit && hit.cycle === ent.cycleStart && now() - hit.at < cacheMs) return hit.state;
    try {
      let rows = await fetchRows(id, ent.cycleStart);
      let s = summarize(rows, now());
      if (!s.hasGrant) {
        if (!(await insert({ chat_id: id, cycle: ent.cycleStart, delta: plan.credits, reason: 'grant', ref: 'monthly grant' }))) throw new Error('grant failed');
        rows = await fetchRows(id, ent.cycleStart);
        s = summarize(rows, now());
      }
      const st = { ...s, metered: true, cycle: ent.cycleStart };
      cache.set(id, { at: now(), cycle: ent.cycleStart, state: st });
      return st;
    } catch {
      if (hit && hit.cycle === ent.cycleStart) return { ...hit.state, stale: true };
      return { known: false, metered: true };
    }
  }

  // Record a spend. Updates the in-memory balance straight away so the next message already sees it.
  async function charge(chatId, ent, cost, { action = null, model = null, ref = null } = {}) {
    const id = String(chatId ?? '');
    if (!cost || cost <= 0 || !ent?.plan || ent.plan.credits == null) return { before: null, after: null, recorded: false };
    const st = await state(id, ent);
    const before = st.known ? st.spent : null;
    if (st.known) { st.spent += cost; st.left -= cost; st.todaySpent += cost; cache.set(id, { at: now(), cycle: ent.cycleStart, state: st }); }
    let recorded = false;
    if (enabled && CHAT_ID_RE.test(id) && ent.cycleStart) {
      const row = { chat_id: id, cycle: ent.cycleStart, delta: -cost, reason: 'spend', action, model, ref };
      try { recorded = await insert(row) || await insert(row); } catch { try { recorded = await insert(row); } catch { recorded = false; } }
      if (!recorded) console.warn(`[meter] could not record a ${cost}-credit spend for chat ${id}`);
    }
    return { before, after: st.known ? st.spent : null, total: st.known ? st.total : null, left: st.known ? st.left : null, recorded };
  }

  // Admin top-up: +TOPUP.credits for the current cycle, within the plan's allowance.
  async function topup(chatId, ent) {
    const id = String(chatId ?? '');
    if (!ent?.plan || ent.plan.credits == null) return { error: 'no-credits' };
    const st = await state(id, ent);
    if (!st.known) return { error: 'unavailable' };
    if (!topupAllowed(ent.plan, st.topupCount)) return { error: 'limit' };
    try {
      if (!(await insert({ chat_id: id, cycle: ent.cycleStart, delta: TOPUP.credits, reason: 'topup', ref: 'top-up' }))) return { error: 'unavailable' };
    } catch { return { error: 'unavailable' }; }
    cache.delete(id);
    return { ok: true, credits: TOPUP.credits };
  }

  // ---- in-memory daily counters + per-minute window --------------------------------------------------
  const key2 = (id) => `${id}:${utcDate(now())}`;
  const counts = (id) => counters.get(key2(String(id))) || { actions: 0, chats: 0 };
  function bump(id, kind) {
    const k = key2(String(id));
    const c = counters.get(k) || { actions: 0, chats: 0 };
    c[kind === 'action' ? 'actions' : 'chats']++;
    counters.set(k, c);
    for (const old of counters.keys()) if (!old.endsWith(utcDate(now()))) counters.delete(old); // forget yesterday
  }
  // -> { ok } or { ok:false, notify } where notify is true only the first time per minute
  function allowMessage(chatId, perMinute) {
    const id = String(chatId);
    const t = now();
    const w = windows.get(id) || { stamps: [], noticeAt: 0 };
    w.stamps = w.stamps.filter((s) => t - s < 60_000);
    if (w.stamps.length >= (perMinute || 10)) {
      const notify = t - w.noticeAt >= 60_000;
      if (notify) w.noticeAt = t;
      windows.set(id, w);
      return { ok: false, notify };
    }
    w.stamps.push(t);
    windows.set(id, w);
    return { ok: true };
  }

  return { enabled, state, charge, topup, counts, bump, allowMessage, invalidate: (id) => cache.delete(String(id)) };
}
