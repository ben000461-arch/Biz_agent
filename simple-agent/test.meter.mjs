// Tests for meter.js — no network. A fake ledger plays Supabase (including its one-grant-per-cycle rule).
import { createMeter, decide, crossing, nextReset, blockMessage, warningMessage, usageMessage, CREDIT_FREE_ACTIONS, actionCosts } from './meter.js';
import { PLANS, ADMIN, SAFE_MODE, dailyCreditCeiling } from './plans.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const NOW = Date.parse('2026-10-23T18:00:00Z');
let clock = NOW;

function fakeLedger({ down = false } = {}) {
  const rows = []; let id = 0;
  const f = async (url, init) => {
    f.calls++;
    if (f.down) throw new Error('offline');
    const u = new URL(url);
    if (init.method === 'GET') {
      const chat = /eq\.(-?\d+)/.exec(u.search)?.[1];
      const cycle = /cycle=eq\.([\d-]+)/.exec(u.search)?.[1];
      return { ok: true, status: 200, json: async () => rows.filter((r) => r.chat_id === chat && r.cycle === cycle).map(({ ts, delta, reason }) => ({ ts, delta, reason })) };
    }
    const row = JSON.parse(init.body);
    if (f.failPost) return { ok: false, status: 500, json: async () => ({}) };
    if (row.reason === 'grant' && rows.some((r) => r.chat_id === row.chat_id && r.cycle === row.cycle && r.reason === 'grant')) return { ok: false, status: 409, json: async () => ({}) };
    rows.push({ id: ++id, ts: new Date(clock).toISOString(), ...row });
    return { ok: true, status: 201, json: async () => ({}) };
  };
  f.rows = rows; f.calls = 0; f.down = down; f.failPost = false;
  return f;
}
const mk = (f) => createMeter({ url: 'http://x', key: 'k', fetchImpl: f, now: () => clock, cacheMs: 20_000 });
const entFor = (key, extra = {}) => ({ state: 'active', canUse: true, planKey: key, plan: PLANS[key], cycleStart: '2026-10-15', anchor: '2026-09-15', ...extra });

// ---- decide ---------------------------------------------------------------------------------------
{
  const pro = PLANS.pro; // 3500 credits, daily ceiling 875, chat on large (costs 2)
  const st = (o) => ({ known: true, left: 3000, total: 3500, spent: 500, todaySpent: 0, topupCount: 0, ...o });
  ok(decide(pro, 'action', st()).ok, 'pro action ok with credits');
  ok(decide(pro, 'chat', st()).tierOverride === undefined, 'pro chat keeps large with credits');
  ok(decide(pro, 'chat', st({ left: 1 })).tierOverride === 'small', 'pro chat drops to small when it cannot afford 2');
  ok(decide(pro, 'chat', st({ left: 0 })).ok === true, 'out of credits still chats');
  let d = decide(pro, 'action', st({ left: 4 }));
  ok(!d.ok && d.reason === 'out_of_credits', 'action blocked under 5 credits');
  d = decide(pro, 'action', st({ todaySpent: 871 }));
  ok(!d.ok && d.reason === 'daily_ceiling', 'action blocked past the daily ceiling');
  ok(decide(pro, 'action', st({ todaySpent: 870 })).ok, 'action allowed right up to the ceiling');
  ok(decide(pro, 'chat', st({ todaySpent: 874 })).tierOverride === 'small', 'large chat drops to small at the ceiling');
  ok(decide(pro, 'action', { known: false }, { actions: 0 }).ok, 'unknown ledger still allows a few actions');
  ok(decide(pro, 'action', { known: false }, { actions: SAFE_MODE.daily.actions }).reason === 'daily_actions', 'unknown ledger caps actions');
  ok(decide(pro, 'chat', { known: false }).tierOverride === 'small', 'unknown ledger chats on small only');
  const trial = PLANS.trial;
  ok(decide(trial, 'action', { known: true, metered: false }, { actions: 19 }).ok && decide(trial, 'action', { known: true }, { actions: 20 }).reason === 'daily_actions', 'trial action cap 20');
  ok(decide(trial, 'chat', { known: true }, { chats: 100 }).reason === 'daily_chats', 'trial chat cap 100');
  ok(decide(PLANS.starter, 'chat', st({ left: 10 }), { chats: 300 }).reason === 'daily_chats', 'starter chat fair use 300');
  ok(decide(PLANS.starter, 'chat', st({ left: 10 }), { chats: 299 }).tierOverride === undefined, 'starter chat stays small (no override needed)');
  ok(decide(ADMIN, 'action', { known: true }, { actions: 9999 }).ok, 'admin unlimited');
  ok(decide(null, 'action', {}).ok, 'no plan: no meter');
}
// ---- crossing -------------------------------------------------------------------------------------
ok(crossing(2795, 2800, 3500) === 0.8, 'crossing exactly 80%');
ok(crossing(2800, 2900, 3500) === null, 'no repeat warning past 80%');
ok(crossing(2700, 3500, 3500) === 1, 'jump straight to 100% gives the 100% warning');
ok(crossing(100, 200, 3500) === null, 'no warning when low');
ok(crossing(0, 5, 0) === null, 'zero total safe');
// ---- nextReset ------------------------------------------------------------------------------------
ok(nextReset('2026-01-31', '2026-02-28') === '2026-03-31', 'anchor 31st: Feb cycle resets Mar 31');
ok(nextReset('2026-09-15', '2026-10-15') === '2026-11-15', 'normal next reset');
ok(nextReset(null, null) === null, 'null safe');
// ---- state / grant / charge -----------------------------------------------------------------------
{
  clock = NOW;
  const f = fakeLedger(); const m = mk(f); const ent = entFor('pro');
  const [a, b] = await Promise.all([m.state('333', ent), m.state('333', ent)]);
  ok(a.known && a.left === 3500 && a.total === 3500, 'first state creates the grant');
  ok(f.rows.filter((r) => r.reason === 'grant').length === 1, 'two racing lookups make ONE grant');
  const r = await m.charge('333', ent, 5, { action: 'draft_email', model: 'x' });
  ok(r.before === 0 && r.after === 5 && r.recorded, 'charge reports before/after and records');
  ok((await m.state('333', ent)).left === 3495, 'balance updated in memory at once');
  ok(f.rows.at(-1).delta === -5 && f.rows.at(-1).action === 'draft_email', 'ledger row written');
  m.invalidate('333');
  const s2 = await m.state('333', ent);
  ok(s2.left === 3495 && s2.todaySpent === 5 && s2.spent === 5, 'fresh read from the ledger agrees');
  // yesterday's spend does not count toward today
  clock = NOW - 86400000; await m.charge('333', ent, 100, { action: 'x' }); clock = NOW; m.invalidate('333');
  const s3 = await m.state('333', ent);
  ok(s3.spent === 105 && s3.todaySpent === 5, "yesterday's spend is in the month but not in today");
  // a new cycle starts a fresh grant
  const next = entFor('pro', { cycleStart: '2026-11-15' });
  ok((await m.state('333', next)).left === 3500, 'new cycle: fresh grant');
  // unmetered plans never touch the ledger
  const calls = f.calls;
  const t = await m.state('555', entFor('trial'));
  ok(t.known && !t.metered && f.calls === calls, 'trial is not metered');
  ok((await m.charge('555', entFor('trial'), 5)).recorded === false && f.calls === calls, 'charging an unmetered plan is a no-op');
  ok((await m.charge('333', ent, 0)).recorded === false, 'zero cost is a no-op');
}
// ---- ledger trouble -------------------------------------------------------------------------------
{
  const f = fakeLedger({ down: true }); const m = mk(f); const ent = entFor('pro');
  ok((await m.state('333', ent)).known === false, 'ledger down: state unknown, no throw');
  const r = await m.charge('333', ent, 5);
  ok(r.recorded === false, 'ledger down: charge does not throw');
  f.down = false; f.failPost = true;
  const m2 = mk(f);
  ok((await m2.state('444', ent)).known === false, 'grant that cannot be written: unknown, no throw');
  f.failPost = false;
  const m3 = mk(f); await m3.state('666', ent);
  f.failPost = true;
  const r3 = await m3.charge('666', ent, 5);
  ok(r3.recorded === false && (await m3.state('666', ent)).left === 3495, 'failed write still counts in memory');
  const bad = createMeter({ url: '', key: '' });
  ok(!bad.enabled && (await bad.state('1', ent)).known === false, 'not configured: unknown, safe');
  ok((await mk(fakeLedger()).state('abc', ent)).known === false, 'bad chat id is refused');
}
// ---- top-ups --------------------------------------------------------------------------------------
{
  const f = fakeLedger(); const m = mk(f); const ent = entFor('starter');
  await m.state('222', ent);
  ok((await m.topup('222', ent)).ok, 'first top-up ok');
  ok((await m.state('222', ent)).left === 1500, 'top-up adds 500');
  ok((await m.topup('222', ent)).ok, 'second top-up ok');
  ok((await m.topup('222', ent)).error === 'limit', 'third top-up refused for Starter (limit 2)');
  ok((await m.state('222', ent)).total === 2000, 'total includes top-ups');
  ok((await m.topup('555', entFor('trial'))).error === 'no-credits', 'trial has no top-ups');
  ok((await mk(fakeLedger({ down: true })).topup('222', ent)).error === 'unavailable', 'top-up with ledger down: unavailable');
}
// ---- counters & rate limit ------------------------------------------------------------------------
{
  clock = NOW; const m = mk(fakeLedger());
  m.bump('1', 'action'); m.bump('1', 'action'); m.bump('1', 'chat');
  ok(m.counts('1').actions === 2 && m.counts('1').chats === 1, 'counters count');
  clock = NOW + 86400000;
  ok(m.counts('1').actions === 0, 'counters reset on a new UTC day');
  clock = NOW;
  const out = [1, 2, 3, 4, 5].map(() => m.allowMessage('9', 3));
  ok(out.slice(0, 3).every((x) => x.ok), 'first 3 messages pass');
  ok(!out[3].ok && out[3].notify === true, '4th is limited and notified');
  ok(!out[4].ok && out[4].notify === false, '5th is limited silently');
  ok(m.allowMessage('8', 3).ok, 'other chats are independent');
  clock = NOW + 61_000;
  ok(m.allowMessage('9', 3).ok, 'allowed again after a minute');
}
// ---- messages -------------------------------------------------------------------------------------
{
  const all = ['out_of_credits', 'daily_ceiling', 'daily_actions', 'daily_chats', 'other'].map((r) => blockMessage(r, { reset: '2026-11-15' }));
  ok(all.every((x) => x && !/undefined|null|NaN/.test(x)), 'block messages are clean');
  ok(/November 15/.test(blockMessage('out_of_credits', { reset: '2026-11-15' })), 'reset date shown');
  ok(/cooptech126@gmail.com/.test(blockMessage('out_of_credits', {})), 'contact shown');
  const w80 = warningMessage(0.8, { left: 700 }, { reset: '2026-11-15' });
  ok(/80%/.test(w80) && /700 left/.test(w80) && /November 15/.test(w80), '80% warning');
  ok(/used all/.test(warningMessage(1, { left: 0 }, { reset: '2026-11-15' })), '100% warning');
  const ent = entFor('pro');
  const u = usageMessage(ent, { known: true, total: 3500, left: 2300, todaySpent: 120 }, { reset: '2026-11-15' });
  ok(/Pro/.test(u) && /1,200 of 3,500 used \(34%\)/.test(u) && /2,300 left/.test(u) && /120 of 875/.test(u), 'usage message numbers');
  ok(/isn't measured in credits/.test(usageMessage({ plan: PLANS.trial, daysLeft: 1 }, { known: true })) && /1 day left/.test(usageMessage({ plan: PLANS.trial, daysLeft: 1 }, {})), 'trial usage message');
  ok(/can't read/.test(usageMessage(ent, { known: false })), 'unknown balance message');
}
// ---- what is free ---------------------------------------------------------------------------------
ok(!actionCosts('chat') && !actionCosts('add') && actionCosts('draft_email') && actionCosts('code_task') && actionCosts('weather'), 'free vs charged actions');
ok(CREDIT_FREE_ACTIONS.has('push_change'), 'pushing an already-paid-for change is free');
ok(dailyCreditCeiling(PLANS.pro) === 875, 'pro ceiling 875');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
