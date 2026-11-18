// entitlement.js tests with a FAKE Supabase (in-process fetch). Not shipped.
import { createEntitlements, frozenMessage, trialReminderMessage } from './entitlement.js';
import { PLANS, ADMIN, SAFE_MODE } from './plans.js';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const DAY = 86400000;

// ---- fake Supabase table ------------------------------------------------------------------------
function makeDb() {
  const db = { rows: {}, calls: [], down: false, delay: 0, headersSeen: [] };
  db.fetch = async (url, opts = {}) => {
    const u = new URL(url); db.calls.push({ method: opts.method, path: u.pathname, query: u.search, body: opts.body });
    db.headersSeen.push(opts.headers || {});
    if (db.down) return new Response('{}', { status: 500 });
    if (u.pathname !== '/rest/v1/tenant_plans') return new Response('{}', { status: 404 });
    const method = opts.method || 'GET';
    if (method === 'GET') {
      const id = decodeURIComponent((u.search.match(/chat_id=eq\.([^&]+)/) || [])[1] || '');
      return Response.json(db.rows[id] ? [db.rows[id]] : []);
    }
    if (method === 'POST') {
      const body = JSON.parse(opts.body); const prefer = (opts.headers || {}).Prefer || '';
      const had = db.rows[body.chat_id];
      if (had && prefer.includes('ignore-duplicates')) return Response.json([]);   // lost the race
      db.rows[body.chat_id] = { ...(had || {}), ...body };
      return prefer.includes('return=representation') ? Response.json([db.rows[body.chat_id]]) : new Response(null, { status: 201 });
    }
    if (method === 'PATCH') {
      const id = decodeURIComponent((u.search.match(/chat_id=eq\.([^&]+)/) || [])[1] || '');
      if (!db.rows[id]) return new Response('[]', { status: 200 });
      Object.assign(db.rows[id], JSON.parse(opts.body)); return new Response(null, { status: 204 });
    }
    return new Response('{}', { status: 405 });
  };
  return db;
}
let t = Date.parse('2026-10-22T20:00:00Z');
const mk = (db, extra = {}) => createEntitlements({ url: 'https://x.supabase.co/rest/v1', key: 'sb_secret_test', fetchImpl: db.fetch, now: () => t, ...extra });
const biz = (id) => ({ chatId: String(id), isAdmin: false });

// ---- admin never touches the database -----------------------------------------------------------
{
  const db = makeDb(); const e = mk(db);
  const a = await e.get({ chatId: '1', isAdmin: true });
  ok(a.state === 'admin' && a.canUse && a.plan === ADMIN, 'the admin is always allowed with every model');
  ok(db.calls.length === 0, 'the admin check makes no database call');
}

// ---- a new chat starts a 30-day trial -----------------------------------------------------------
{
  const db = makeDb(); const e = mk(db);
  const a = await e.get(biz(111));
  ok(a.state === 'trial' && a.canUse && a.plan === PLANS.trial, 'a chat we have never seen starts a trial');
  ok(a.daysLeft === 30 && a.trialDay === 0, 'it has 30 days left on day 0');
  ok(db.rows['111']?.plan === 'trial' && new Date(db.rows['111'].ends_at).getTime() === t + 30 * DAY, 'the trial row was saved ending in 30 days');
  const before = db.calls.length;
  await e.get(biz(111)); await e.get(biz(111));
  ok(db.calls.length === before, 'the answer is cached for a minute (no repeat lookups)');
  t += 61_000;
  await e.get(biz(111));
  ok(db.calls.length > before, 'after a minute it looks again');
  t += 10 * DAY;
  e.invalidate(111);
  const b = await e.get(biz(111));
  ok(b.state === 'trial' && b.daysLeft === 20 && b.trialDay === 10, 'ten days later: 20 days left');
  ok(b.plan.models.writer === 'large', 'a trial writes with the 70B');
  t = new Date(db.rows['111'].ends_at).getTime() - 1000; e.invalidate(111);
  ok((await e.get(biz(111))).state === 'trial', 'one second before the end it is still a trial');
  t += 1000; e.invalidate(111);
  const c = await e.get(biz(111));
  ok(c.state === 'frozen' && !c.canUse && c.reason === 'trial_ended', 'at the end of day 30 the trial is frozen');
  ok(c.plan === null, 'a frozen account has no plan to run on');
  t = Date.parse('2026-10-22T20:00:00Z');
}

// ---- two messages at once create one trial, not two ---------------------------------------------
{
  const db = makeDb(); const e = mk(db);
  const [x, y] = await Promise.all([e.get(biz(222)), e.get(biz(222))]);
  ok(x.state === 'trial' && y.state === 'trial', 'two simultaneous first messages both get a trial');
  ok(Object.keys(db.rows).length === 1, 'only one row exists');
}

// ---- paid plans, pilot, manual freeze -----------------------------------------------------------
{
  const db = makeDb(); const e = mk(db);
  db.rows['300'] = { chat_id: '300', plan: 'starter', ends_at: null, cycle_anchor: '2026-10-15', created_at: '2026-10-01T00:00:00Z' };
  db.rows['301'] = { chat_id: '301', plan: 'pro', ends_at: new Date(t + 5 * DAY).toISOString(), cycle_anchor: '2026-10-15' };
  db.rows['302'] = { chat_id: '302', plan: 'business', ends_at: new Date(t - 2 * DAY).toISOString(), cycle_anchor: '2026-10-15' };   // lapsed 2 days: in grace
  db.rows['303'] = { chat_id: '303', plan: 'business', ends_at: new Date(t - 4 * DAY).toISOString(), cycle_anchor: '2026-10-15' };   // lapsed 4 days: over grace
  db.rows['304'] = { chat_id: '304', plan: 'pilot', ends_at: null, cycle_anchor: '2026-10-20' };
  db.rows['305'] = { chat_id: '305', plan: 'pilot', ends_at: new Date(t - DAY).toISOString(), cycle_anchor: '2026-10-20' };
  db.rows['306'] = { chat_id: '306', plan: 'frozen', cycle_anchor: '2026-10-20' };
  db.rows['307'] = { chat_id: '307', plan: 'platinum', cycle_anchor: '2026-10-20' };
  const s = await e.get(biz(300));
  ok(s.state === 'active' && s.plan === PLANS.starter && s.plan.models.writer === 'small', 'Starter is active on the 8B');
  ok(s.cycleStart === '2026-10-15', 'its credit cycle started on the 15th');
  const p = await e.get(biz(301)); ok(p.state === 'active' && p.plan === PLANS.pro && p.plan.models.chat === 'large', 'Pro is active on the 70B');
  const g = await e.get(biz(302)); ok(g.state === 'active' && g.canUse, 'a lapsed plan is still served for the 3-day grace');
  const f = await e.get(biz(303)); ok(f.state === 'frozen' && f.reason === 'lapsed', 'after the grace it freezes');
  const pi = await e.get(biz(304)); ok(pi.state === 'pilot' && pi.canUse && pi.plan === PLANS.pilot, 'a pilot with no end date is never frozen');
  const pe = await e.get(biz(305)); ok(pe.state === 'frozen' && pe.reason === 'pilot_ended', 'a pilot with a past end date freezes');
  const m = await e.get(biz(306)); ok(m.state === 'frozen' && m.reason === 'manual', 'a manual freeze freezes');
  const u = await e.get(biz(307)); ok(u.state === 'frozen' && u.reason === 'unknown_plan', 'an unknown plan name fails closed');
}

// ---- Supabase down ------------------------------------------------------------------------------
{
  const db = makeDb(); const e = mk(db);
  db.down = true;
  const a = await e.get(biz(400));
  ok(a.state === 'limited' && a.canUse && a.plan === SAFE_MODE && a.plan.models.writer === 'small', 'down and never seen: limited mode on the cheap models');
  const n = db.calls.length; await e.get(biz(400));
  ok(db.calls.length === n, 'a failed lookup is not hammered again for 10 seconds');
  db.down = false; t += 11_000;
  ok((await e.get(biz(400))).state === 'trial', 'when it comes back the customer gets their real answer');
  // a known customer keeps their last answer while it is down
  db.rows['401'] = { chat_id: '401', plan: 'pro', cycle_anchor: '2026-10-15' };
  const k = await e.get(biz(401)); t += 61_000; db.down = true;
  const k2 = await e.get(biz(401));
  ok(k.state === 'active' && k2.state === 'active' && k2.stale === true, 'a known customer keeps their plan (marked stale) during an outage');
  db.down = false; t = Date.parse('2026-10-22T20:00:00Z');
}
{ // never configured
  const e = createEntitlements({ url: '', key: '' });
  const a = await e.get(biz(500)); ok(a.state === 'limited' && !e.enabled, 'no Supabase settings: limited mode, no crash');
  const r = await e.setPlan(500, { plan: 'pro' }); ok(r.error === 'unavailable', 'cannot set a plan without Supabase');
}

// ---- bad input ----------------------------------------------------------------------------------
{
  const db = makeDb(); const e = mk(db);
  for (const bad of ['abc', "1; drop table", '../x', '', undefined, '1 2', '12345678901234567890123']) {
    const a = await e.get({ chatId: bad });
    ok(a.state === 'frozen' && !a.canUse, `an odd chat id (${String(bad).slice(0, 12)}) is refused`);
  }
  ok(db.calls.length === 0, 'odd chat ids never reach the database');
  ok((await e.get(biz(-100123456))).state === 'trial', 'a group chat id (negative number) is fine');
}

// ---- setPlan ------------------------------------------------------------------------------------
{
  const db = makeDb(); const e = mk(db);
  await e.get(biz(600));
  ok((await e.get(biz(600))).state === 'trial', 'starts as a trial');
  const r = await e.setPlan(600, { plan: 'pro' });
  ok(r.ok && (await e.get(biz(600))).planKey === 'pro', 'setting a plan takes effect immediately (cache cleared)');
  ok((await e.setPlan(600, { plan: 'platinum' })).error === 'bad-plan', 'a made-up plan is refused');
  ok((await e.setPlan('x', { plan: 'pro' })).error === 'bad-chat', 'a bad chat id is refused');
  ok((await e.setPlan(600, { plan: 'frozen' })).ok && (await e.get(biz(600))).state === 'frozen', 'an admin can freeze');
  await e.setPlan(600, { plan: 'pilot', endsAt: new Date(t + 60 * DAY) });
  const p = await e.get(biz(600)); ok(p.state === 'pilot' && p.endsAt === new Date(t + 60 * DAY).toISOString(), 'a pilot can have an end date');
  db.down = true; ok((await e.setPlan(600, { plan: 'pro' })).error === 'failed', 'a failed save is reported');
}

// ---- key handling -------------------------------------------------------------------------------
{
  const db = makeDb(); const e = mk(db); await e.get(biz(700));
  ok(db.headersSeen.every((h) => h.apikey === 'sb_secret_test' && !h.authorization), 'new-style secret keys go only in the apikey header');
  const db2 = makeDb(); const e2 = mk(db2, { key: 'eyJhbGciOi.old.jwt' }); await e2.get(biz(701));
  ok(db2.headersSeen.every((h) => h.authorization === 'Bearer eyJhbGciOi.old.jwt'), 'old-style JWT keys also go in Authorization');
}

// ---- trial reminders ----------------------------------------------------------------------------
{
  const db = makeDb(); const e = mk(db);
  const day = async (n) => { t = Date.parse('2026-10-22T20:00:00Z') + n * DAY; e.invalidate(800); return e.get(biz(800)); };
  await e.get(biz(800));
  ok(e.reminderDue(await day(10)) === null, 'day 10: no reminder');
  ok(e.reminderDue(await day(24)) === null, 'day 24: no reminder');
  const d25 = await day(25); ok(e.reminderDue(d25) === 25, 'day 25: first reminder');
  await e.markReminder(800, 25);
  ok(e.reminderDue(await day(26)) === null, 'day 26: already reminded');
  ok(e.reminderDue(await day(28)) === 28, 'day 28: second reminder');
  await e.markReminder(800, 28);
  ok(e.reminderDue(await day(29)) === null, 'day 29: nothing new');
  ok(e.reminderDue(await day(29.9)) === null, 'still nothing before day 30');
  const d30 = await day(30); ok(d30.state === 'frozen' && e.reminderDue(d30) === null, 'a frozen trial gets no reminder (it gets the frozen message instead)');
  // skipped days: the bot was off on day 25 and 28, turns on at 29 -> send only the latest due one
  const db2 = makeDb(); const e2 = mk(db2); t = Date.parse('2026-10-22T20:00:00Z'); await e2.get(biz(801));
  t += 29 * DAY; e2.invalidate(801); ok(e2.reminderDue(await e2.get(biz(801))) === 28, 'bot was off for days: only the latest missed reminder is sent');
  ok(e.reminderDue({ state: 'active' }) === null && e.reminderDue(null) === null, 'paid plans and nulls get no reminder');
  ok((await e.markReminder(800, 99)).error === 'failed' && (await e.markReminder('x', 25)).error === 'failed', 'bad reminder inputs are refused');
  t = Date.parse('2026-10-22T20:00:00Z');
}

// ---- fixed messages -----------------------------------------------------------------------------
{
  const site = 'https://ben000461-arch.github.io/coop-agent-legal/';
  const m1 = frozenMessage({ reason: 'trial_ended' }, { siteUrl: site });
  ok(/free trial has ended/.test(m1) && m1.includes(`${site}dashboard.html`) && m1.includes('cooptech126@gmail.com'), 'trial-ended message names the trial, the dashboard and who to email');
  ok(/data is safe/i.test(m1) && !/delete/.test(m1.replace('nothing was deleted', '')), 'it says data is safe');
  ok(/pilot period/.test(frozenMessage({ reason: 'pilot_ended' })) && /payment period/.test(frozenMessage({ reason: 'lapsed' })) && /paused right now/.test(frozenMessage({ reason: 'manual' })), 'each freeze reason has its own wording');
  ok(!frozenMessage({ reason: 'trial_ended' }).includes('dashboard.html'), 'no site link when no site is set');
  ok(!/\$|upgrade now|checkout|pay here/i.test(m1), 'it promises no payment page that does not exist yet');
  ok(/tomorrow/.test(trialReminderMessage({ daysLeft: 1 })) && /in 5 days/.test(trialReminderMessage({ daysLeft: 5 })) && /today/.test(trialReminderMessage({ daysLeft: 0 })), 'reminder wording reads naturally');
}

console.log(`entitlement: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
