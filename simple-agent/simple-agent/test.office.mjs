// Office dashboard data: who sees what, what a task records, and the /web/office doors. FAKE Supabase.
import express from 'express';
import { createOffice } from './office.js';
import { mountWebApi } from './webapi.js';

let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) pass++; else { fail++; console.log('  FAIL ', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400)); } };

// ---- a tiny fake of Supabase's REST API (just what office.js uses)
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const db = {
  office_businesses: [{ chat_id: '100', name: 'Demo Office', accent: '#3b5bdb' }, { chat_id: '200', name: 'Other Co', accent: null }],
  office_members: [
    { chat_id: '100', email: 'owner@demo.test', user_id: U(1), name: 'Ben', role: 'owner', status: 'active' },
    { chat_id: '100', email: 'emp@demo.test', user_id: U(2), name: 'Sam', role: 'employee', status: 'active' },
    { chat_id: '200', email: 'boss@other.test', user_id: U(3), name: '', role: 'owner', status: 'active' },
    { chat_id: '100', email: 'gone@demo.test', user_id: U(4), name: '', role: 'employee', status: 'removed' },
    { chat_id: '100', email: 'new@demo.test', user_id: null, name: '', role: 'employee', status: 'invited' },
  ],
  office_activity: [],
};
let nextId = 1;
const calls = [];
const fakeFetch = async (url, opt = {}) => {
  const u = new URL(url); const table = u.pathname.split('/').pop();
  calls.push({ method: opt.method || 'GET', table, search: decodeURIComponent(u.search), body: opt.body });
  if (opt.method === 'POST') { const row = JSON.parse(opt.body); db[table].push({ id: nextId++, ts: new Date().toISOString(), ...row }); return new Response('', { status: 201 }); }
  let rows = [...db[table]];
  let limit = Infinity, order = null;
  for (const [k, v] of u.searchParams) {
    if (k === 'select') continue;
    if (k === 'limit') { limit = Number(v); continue; }
    if (k === 'order') { order = v; continue; }
    const [op, ...rest] = v.split('.'); const val = rest.join('.');
    rows = rows.filter((r) => {
      const x = r[k];
      if (op === 'eq') return String(x) === val;
      if (op === 'neq') return String(x) !== val;
      if (op === 'lt') return Number(x) < Number(val);
      if (op === 'gte') return String(x) >= val;
      return true;
    });
  }
  if (order === 'id.desc') rows.sort((a, b) => b.id - a.id);
  return new Response(JSON.stringify(rows.slice(0, limit)), { status: 200 });
};
const office = createOffice({ url: 'https://sb.test', key: 'sb_secret_x', fetchImpl: fakeFetch });

// ---- who is who
check('owner is found with their business and role', JSON.stringify(await office.member(U(1))) === JSON.stringify({ chatId: '100', email: 'owner@demo.test', name: 'Ben', role: 'owner' }));
check('employee is found as an employee', (await office.member(U(2))).role === 'employee');
check('a removed person is not a member any more', (await office.member(U(4))).error === 'not_member');
check('a stranger is not a member', (await office.member(U(9))).error === 'not_member');
check('garbage ids are refused without asking the database', (await office.member("1' or 1=1")).error === 'not_member' && !calls.some((c) => c.search.includes("or 1=1")));
const before = calls.length; await office.member(U(1));
check('members are remembered for a moment (no database call every request)', calls.length === before);

// ---- recording a task
const owner = { ...(await office.member(U(1))), userId: U(1) };
const emp = { ...(await office.member(U(2))), userId: U(2) };
const other = { ...(await office.member(U(3))), userId: U(3) };
await office.logTask(emp, { url: 'https://mail.google.com/mail/u/0/#inbox', request: 'Email Sam the totals, my SSN is 123-45-6789', outcome: 'done', auto: false, done: 3, total: 3,
  steps: [{ what: 'Fill “To recipients”', ok: true, value: 'secret@x.com' }, { what: 'Fill “Subject”', ok: true }, { what: 'Click “Send”', ok: true }] });
const t1 = db.office_activity[0];
check('task: request kept in their words, SSN hidden', t1.request === 'Email Sam the totals, my SSN is [SSN hidden]', t1.request);
check('task: only the site name, not the address', t1.site === 'mail.google.com');
check('task: steps keep the name and whether it worked, never what was typed', JSON.stringify(t1.steps) === JSON.stringify([{ what: 'Fill “To recipients”', ok: true }, { what: 'Fill “Subject”', ok: true }, { what: 'Click “Send”', ok: true }]) && !JSON.stringify(t1).includes('secret@x.com'));
check('task: approved by a person, in their business, under their name', t1.approval === 'approved' && t1.chat_id === '100' && t1.user_id === U(2) && t1.email === 'emp@demo.test');
await office.logTask(emp, { url: 'https://docs.google.com/document/d/x', request: 'add a line', outcome: 'done', auto: true, done: 1, total: 1, steps: [{ what: 'Add to “Document”', ok: true }] });
await office.logTask(emp, { url: 'https://x.com', request: 'delete it all', outcome: 'cancelled', denied: true, done: 0, total: 2 });
await office.logTask(owner, { url: 'https://sheets.google.com', request: 'owner task', outcome: 'partial', auto: false, done: 1, total: 2, steps: [{ what: 'Fill “B7”', ok: true }, { what: 'Fill “B8”', ok: false }] });
await office.logTask(other, { url: 'https://other.com', request: 'OTHER BUSINESS SECRET', outcome: 'done', auto: true, done: 1, total: 1 });
check('task: ran on its own / denied are recorded as such', db.office_activity[1].approval === 'auto' && db.office_activity[2].approval === 'denied');
check('task: a made-up outcome is refused', (await office.logTask(emp, { outcome: 'hacked' })).ok === false && db.office_activity.length === 5);
check('task: long requests are cut to 500 characters', (await office.logTask(emp, { url: 'https://a.com', request: 'x'.repeat(5000), outcome: 'done' })).ok && db.office_activity[5].request.length === 500);
db.office_activity.pop();

// ---- reading: walls
const reqs = (rows) => rows.map((r) => r.request);
const ownerSees = reqs((await office.activity(owner)).rows);
check('owner sees the whole business, newest first', JSON.stringify(ownerSees) === JSON.stringify(['owner task', 'delete it all', 'add a line', 'Email Sam the totals, my SSN is [SSN hidden]']), ownerSees);
check('owner can look at one person', JSON.stringify(reqs((await office.activity(owner, { person: U(2) })).rows)) === JSON.stringify(['delete it all', 'add a line', 'Email Sam the totals, my SSN is [SSN hidden]']));
check('employee sees only their own work', JSON.stringify(reqs((await office.activity(emp)).rows)) === JSON.stringify(['delete it all', 'add a line', 'Email Sam the totals, my SSN is [SSN hidden]']));
check('employee can NOT look at someone else by asking for them', !reqs((await office.activity(emp, { person: U(1) })).rows).includes('owner task'));
check('another business never sees ours', JSON.stringify(reqs((await office.activity(other)).rows)) === JSON.stringify(['OTHER BUSINESS SECRET']));
check('older pages: "before" an id', JSON.stringify(reqs((await office.activity(owner, { before: 3, limit: 5 })).rows)) === JSON.stringify(['add a line', 'Email Sam the totals, my SSN is [SSN hidden]']));
const sum = await office.summary(owner);
check('summary: last 7 days counted right', sum.tasks === 4 && sum.done === 2 && sum.problems === 1 && sum.approved === 2 && sum.auto === 1 && sum.denied === 1, sum);
check('summary: an employee gets their own numbers', (await office.summary(emp)).tasks === 3);
const team = await office.team(owner);
check('team: owner sees the people (not removed ones), invited ones marked', team.people.length === 3 && team.people.some((p) => p.email === 'new@demo.test' && p.status === 'invited') && !team.people.some((p) => p.email === 'gone@demo.test'), team);
check('team: employees don\'t get the team list', (await office.team(emp)).people.length === 0);
check('business name and color', JSON.stringify(await office.business('100')) === JSON.stringify({ name: 'Demo Office', accent: '#3b5bdb' }));

// ---- the /web/office doors
const app = express();
const tokens = { 'tok-owner-123456': U(1), 'tok-emp-1234567': U(2), 'tok-other-123456': U(3), 'tok-gone-1234567': U(4), 'tok-stranger-12': U(9) };
const auth = { verify: async (t) => (tokens[t] ? { userId: tokens[t] } : { error: 'unauthorized' }), chatFor: async () => ({ error: 'unlinked' }) };
mountWebApi(app, { express, auth, getTenant: () => null, ops: {}, office, siteOrigin: 'https://co-optech.com' });
const srv = app.listen(0); const port = srv.address().port;
const get = async (path, tok, origin = 'https://co-optech.com') => {
  const r = await fetch(`http://127.0.0.1:${port}/web${path}`, { headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), origin } });
  let body = null; try { body = await r.json(); } catch { /* */ }
  return { status: r.status, body };
};
check('door: signed out gets nothing', (await get('/office/activity')).status === 401);
check('door: a login that isn\'t in an office is told so plainly', (await get('/office/me', 'tok-stranger-12')).status === 403 && /owner to add your email/.test((await get('/office/me', 'tok-stranger-12')).body.message));
check('door: a removed person is shut out', (await get('/office/activity', 'tok-gone-1234567')).status === 403);
const me = await get('/office/me', 'tok-owner-123456');
check('door: /me says business, role and email', me.status === 200 && me.body.business.name === 'Demo Office' && me.body.role === 'owner' && me.body.email === 'owner@demo.test', me.body);
const ea = await get('/office/activity', 'tok-emp-1234567');
check('door: employee activity is only theirs', ea.status === 200 && ea.body.rows.length === 3 && ea.body.more === false);
const oa = await get(`/office/activity?person=${U(2)}`, 'tok-owner-123456');
check('door: owner can filter by person', oa.body.rows.length === 3);
check('door: other business sees only theirs', (await get('/office/activity', 'tok-other-123456')).body.rows.map((r) => r.request).join() === 'OTHER BUSINESS SECRET');
check('door: summary works', (await get('/office/summary', 'tok-owner-123456')).body.tasks === 4);
check('door: team list for the owner only', (await get('/office/team', 'tok-owner-123456')).body.people.length === 3 && (await get('/office/team', 'tok-emp-1234567')).body.people.length === 0);
check('door: other websites can\'t call it', (await get('/office/me', 'tok-owner-123456', 'https://evil.test')).status === 403);
srv.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
