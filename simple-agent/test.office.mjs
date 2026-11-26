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
  tenant_users: [{ user_id: U(1), chat_id: '100' }],
};
db.office_members.forEach((m, i) => { m.id = i + 1; });
let memberId = db.office_members.length + 1;
const registered = new Set(['already@demo.test']); // logins that already exist
const invites = [], recovers = [];
let nextId = 1;
const calls = [];
const matches = (u) => (r) => {
  for (const [k, v] of u.searchParams) {
    if (['select', 'limit', 'order', 'redirect_to'].includes(k)) continue;
    const [op, ...rest] = v.split('.'); const val = rest.join('.'); const x = r[k];
    if (op === 'eq' && String(x) !== val) return false;
    if (op === 'neq' && String(x) === val) return false;
    if (op === 'lt' && !(Number(x) < Number(val))) return false;
    if (op === 'gte' && !(String(x) >= val)) return false;
  }
  return true;
};
const fakeFetch = async (url, opt = {}) => {
  const u = new URL(url); const table = u.pathname.split('/').pop();
  calls.push({ method: opt.method || 'GET', table, search: decodeURIComponent(u.search), body: opt.body, headers: opt.headers });
  if (u.pathname === '/auth/v1/invite') {
    const b = JSON.parse(opt.body); invites.push({ email: b.email, redirect: u.searchParams.get('redirect_to'), data: b.data, auth: opt.headers });
    if (registered.has(b.email)) return new Response('{"msg":"A user with this email address has already been registered"}', { status: 422 });
    return new Response('{}', { status: 200 });
  }
  if (u.pathname === '/auth/v1/recover') {
    const b = JSON.parse(opt.body); recovers.push({ email: b.email, redirect: u.searchParams.get('redirect_to'), auth: opt.headers });
    return new Response('{}', { status: 200 });
  }
  if (opt.method === 'POST') {
    const row = JSON.parse(opt.body);
    if (table === 'office_members') { if (db.office_members.some((m) => m.email === row.email)) return new Response('', { status: 409 }); db.office_members.push({ id: memberId++, user_id: null, ...row }); return new Response('', { status: 201 }); }
    if (table === 'tenant_users') { if (!db.tenant_users.some((t) => t.user_id === row.user_id)) db.tenant_users.push(row); return new Response('', { status: 201 }); }
    db[table].push({ id: nextId++, ts: new Date().toISOString(), ...row }); return new Response('', { status: 201 });
  }
  if (opt.method === 'PATCH') { const ch = JSON.parse(opt.body); db[table].filter(matches(u)).forEach((r) => Object.assign(r, ch)); return new Response(null, { status: 204 }); }
  if (opt.method === 'DELETE') { db[table] = db[table].filter((r) => !matches(u)(r)); return new Response(null, { status: 204 }); }
  let rows = db[table].filter(matches(u));
  const limit = Number(u.searchParams.get('limit')) || Infinity, order = u.searchParams.get('order');
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
check('summary: 7 days for the chart, today last, counted by outcome', sum.days.length === 7 && sum.days[6].done === 2 && sum.days[6].problems === 1 && sum.days[6].denied === 1 && sum.today === 4, sum.days);
check('summary: who did the most (owner only) and where', sum.people[0].email === 'emp@demo.test' && sum.people[0].tasks === 3 && sum.sites.length === 4 && sum.sites.some((x) => x.site === 'mail.google.com'), { p: sum.people, s: sum.sites });
check('summary: employees don\'t get the team breakdown', (await office.summary(emp)).people.length === 0);
check('summary: an employee gets their own numbers', (await office.summary(emp)).tasks === 3);
const team = await office.team(owner);
check('team: owner sees the people (not removed ones), invited ones marked', team.people.length === 3 && team.people.every((p) => p.memberId) && team.people.some((p) => p.email === 'new@demo.test' && p.status === 'invited') && !team.people.some((p) => p.email === 'gone@demo.test'), team);
check('team: employees don\'t get the team list', (await office.team(emp)).people.length === 0);
check('business name and color', JSON.stringify(await office.business('100')) === JSON.stringify({ name: 'Demo Office', accent: '#3b5bdb' }));

// ---- Team: invite, join, remove
const inv = await office.invite(owner, { email: '  New.Hire@Demo.TEST ', name: 'Nia Park' }, { redirectTo: 'https://www.co-optech.com/office/', office: 'Demo Office' });
const nia = db.office_members.find((m) => m.email === 'new.hire@demo.test');
check('invite: added as invited, email tidied, invite email sent with the link back to the office', inv.ok && inv.sent && nia?.status === 'invited' && nia.chat_id === '100' && nia.name === 'Nia Park' && invites.at(-1).email === 'new.hire@demo.test' && invites.at(-1).redirect === 'https://www.co-optech.com/office/' && invites.at(-1).data.office === 'Demo Office', { inv, nia, last: invites.at(-1) });
check('invite: the sign-in service is called with the server key, never a person\'s token', invites.at(-1).auth.apikey === 'sb_secret_x');
check('invite: one email, one office (another office\'s person can\'t be added)', (await office.invite(owner, { email: 'boss@other.test' })).error === 'taken');
check('invite: someone already on the team', (await office.invite(owner, { email: 'emp@demo.test' })).error === 'already_member');
check('invite: only the owner can invite', (await office.invite(emp, { email: 'x@demo.test' })).error === 'owner_only');
check('invite: not an email', (await office.invite(owner, { email: 'not an email' })).error === 'bad_email' && (await office.invite(owner, { email: 'a@b' })).error === 'bad_email');
const ex = await office.invite(owner, { email: 'already@demo.test' }, { redirectTo: 'https://www.co-optech.com/office/' });
check('invite: someone who already has a login gets a "set your password" link instead', ex.ok && ex.existing === true && ex.sent === true && recovers.at(-1)?.email === 'already@demo.test' && recovers.at(-1).redirect === 'https://www.co-optech.com/office/' && recovers.at(-1).auth.apikey === 'sb_secret_x', { ex, r: recovers.at(-1) });
const exAgain = await office.resend(owner, db.office_members.find((m) => m.email === 'already@demo.test').id, { redirectTo: 'https://www.co-optech.com/office/' });
check('resend: works again for them (the stuck case)', exAgain.sent === true && recovers.length === 2);
// ---- has this business also signed up for Agent?
db.tenant_plans = [{ chat_id: '100' }];
check('hasAgent: a business with a plan', (await office.hasAgent('100')) === true);
check('hasAgent: an office-only business', (await office.hasAgent('555')) === false);
check('hasAgent: junk id', (await office.hasAgent('1;drop')) === false);
// ---- Account: rename yourself
const empRow = db.office_members.find((m) => m.email === 'emp@demo.test');
const rn = await office.rename({ ...emp, userId: empRow.user_id }, '  Sam\u0007 Ortiz  ');
check('rename: tidies the name and changes only your own row', rn.ok && rn.name === 'Sam Ortiz' && empRow.name === 'Sam Ortiz' && calls.at(-1).search.includes(`user_id=eq.${empRow.user_id}`) && calls.at(-1).search.includes('chat_id=eq.100'), { rn, empRow, s: calls.at(-1)?.search });
check('rename: empty name refused', (await office.rename({ ...emp, userId: empRow.user_id }, '   ')).error === 'bad_name');
check('rename: needs a real login id', (await office.rename({ ...emp, userId: 'x' }, 'A')).error === 'unavailable');
const before2 = invites.length;
check('resend: only for people still invited', (await office.resend(owner, nia.id)).sent === true && invites.length === before2 + 1 && (await office.resend(owner, 2)).error === 'not_found' && (await office.resend(emp, nia.id)).error === 'owner_only');
// first sign-in
const NIA = U(7);
check('join: an unconfirmed email can\'t claim an invite', (await office.claim(NIA, 'new.hire@demo.test', false)).ok === false && !nia.user_id);
check('join: a different email can\'t claim it', (await office.claim(NIA, 'someone@else.test', true)).ok === false);
const cl = await office.claim(NIA, 'New.Hire@demo.test', true);
check('join: their confirmed email claims the invite: active, linked to the office (extension works too)', cl.ok && nia.user_id === NIA && nia.status === 'active' && nia.joined_at && db.tenant_users.some((t) => t.user_id === NIA && t.chat_id === '100'), { nia, tu: db.tenant_users });
check('join: now they\'re a member (employee)', (await office.member(NIA)).role === 'employee');
check('join: nobody else can claim it after', (await office.claim(U(8), 'new.hire@demo.test', true)).ok === false && nia.user_id === NIA);
check('join: never overwrites an existing extension link', (await office.claim(U(1), 'owner@demo.test', true)) && db.tenant_users.filter((t) => t.user_id === U(1)).length === 1);
// remove
check('remove: the owner can\'t be removed', (await office.remove(owner, 1)).error === 'cant_remove_owner');
check('remove: only the owner can remove', (await office.remove(emp, nia.id)).error === 'owner_only');
check('remove: another office\'s person can\'t be removed from here', (await office.remove(owner, 3)).error === 'not_found');
const rm = await office.remove(owner, nia.id);
check('remove: cut off at once: removed, extension link gone, no longer a member', rm.ok && nia.status === 'removed' && !db.tenant_users.some((t) => t.user_id === NIA) && (await office.member(NIA)).error === 'not_member', { nia, tu: db.tenant_users });
check('remove: a removed person can\'t sign back in to claim it', (await office.claim(NIA, 'new.hire@demo.test', true)).ok === false);
const back = await office.invite(owner, { email: 'new.hire@demo.test' });
check('re-invite: a removed person can be invited again (fresh, unlinked)', back.ok && nia.status === 'invited' && nia.user_id === null);

// ---- the /web/office doors
const app = express();
const tokens = { 'tok-owner-123456': U(1), 'tok-emp-1234567': U(2), 'tok-other-123456': U(3), 'tok-gone-1234567': U(4), 'tok-stranger-12': U(9), 'tok-nia-12345678': NIA };
const emails = { [NIA]: 'new.hire@demo.test' };
const forgotten = [];
const auth = { verify: async (t) => (tokens[t] ? { userId: tokens[t], email: emails[tokens[t]] || '', emailConfirmed: true } : { error: 'unauthorized' }), chatFor: async () => ({ error: 'unlinked' }), forgetLink: (id) => forgotten.push(id) };
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
check('door: team list for the owner only', (await get('/office/team', 'tok-owner-123456')).body.people.length >= 3 && (await get('/office/team', 'tok-emp-1234567')).body.people.length === 0);
check('door: other websites can\'t call it', (await get('/office/me', 'tok-owner-123456', 'https://evil.test')).status === 403);
check('door: an invited person\'s first sign-in links them and lets them in', (await get('/office/me', 'tok-nia-12345678')).body?.role === 'employee' && nia.status === 'active');
const post = async (path, tok, body, origin = 'https://co-optech.com') => {
  const r = await fetch(`http://127.0.0.1:${port}/web${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body) });
  let b = null; try { b = await r.json(); } catch { /* */ } return { status: r.status, body: b };
};
const pi = await post('/office/team/invite', 'tok-owner-123456', { email: 'second@demo.test', name: 'Sam Two' });
check('door: owner invites, gets a plain note', pi.status === 200 && pi.body.sent && /Invite sent/.test(pi.body.note) && invites.at(-1).redirect === 'https://co-optech.com/office/', pi);
check('door: employees can\'t invite', (await post('/office/team/invite', 'tok-emp-1234567', { email: 'z@demo.test' })).status === 403);
check('door: another office\'s email: a plain message', /another office/.test((await post('/office/team/invite', 'tok-owner-123456', { email: 'boss@other.test' })).body.message));
const pr = await post('/office/team/remove', 'tok-owner-123456', { memberId: nia.id });
check('door: owner removes, and the extension link is forgotten right away', pr.status === 200 && forgotten.includes(NIA) && (await get('/office/me', 'tok-nia-12345678')).status === 403);
check('door: other websites can\'t change the team', (await post('/office/team/invite', 'tok-owner-123456', { email: 'q@demo.test' }, 'https://evil.test')).status === 403);
srv.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
