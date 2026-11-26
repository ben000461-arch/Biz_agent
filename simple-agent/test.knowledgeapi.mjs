// The /web/office/knowledge routes: sign-in first, upload limits, safe downloads, owner-only reviews.
import express from 'express';
import { mountWebApi } from './webapi.js';
let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300)); } };
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const people = { 'tok-owner': { userId: U(1), email: 'ben@x.test', role: 'owner' }, 'tok-emp': { userId: U(2), email: 'sam@x.test', role: 'employee' } };
const auth = { verify: async (t) => (people[t] ? { userId: people[t].userId, email: people[t].email, emailConfirmed: true } : { error: 'unauthorized' }), chatFor: async () => ({ error: 'unlinked' }) };
const office = { enabled: true, member: async (uid) => { const p = Object.values(people).find((x) => x.userId === uid); return p ? { chatId: '100', role: p.role, email: p.email, name: '' } : { error: 'not_member' }; }, business: async () => ({ name: 'Demo' }), hasAgent: async () => false, claim: async () => ({}) };
const seen = [];
const knowledge = {
  enabled: true, excel: false,
  list: async (m) => ({ items: [{ id: 'a', title: m.role }] }),
  read: async () => ({ item: { id: 'a', body: 'x' } }),
  addNote: async (m, b) => { seen.push(['note', m.role, b]); return b.title ? { ok: true, id: 'n1', status: m.role === 'owner' ? 'approved' : 'pending' } : { error: 'no_title' }; },
  addFile: async (m, f) => { seen.push(['file', m.role, f.name, f.title, f.buf.length]); return f.name.endsWith('.exe') ? { error: 'type', message: 'That kind of file isn’t supported.' } : { ok: true, id: 'f1', status: 'pending' }; },
  review: async (m) => (m.role === 'owner' ? { ok: true, status: 'approved' } : { error: 'owner_only' }),
  remove: async () => ({ ok: true }),
  download: async (m, id) => (id === 'f1' ? { buf: Buffer.from('<script>alert(1)</script>'), name: 'pr"ice ü.csv' } : { error: 'not_found' }),
  pendingCount: async () => 3,
};
const app = express(); app.set('trust proxy', false);
mountWebApi(app, { express, auth, getTenant: () => null, ops: {}, office, knowledge, siteOrigin: 'https://www.co-optech.com' });
const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}/web/office`;
const go = async (path, { method = 'GET', tok, body, type, origin = 'https://www.co-optech.com' } = {}) => {
  const headers = { origin, ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(type ? { 'content-type': type } : {}) };
  const r = await fetch(base + path, { method, headers, body });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, h: r.headers, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};
try {
  check('signed out: refused', (await go('/knowledge')).status === 401);
  check('another website: refused', (await go('/knowledge', { tok: 'tok-owner', origin: 'https://evil.test' })).status === 403);
  check('owner list', (await go('/knowledge', { tok: 'tok-owner' })).body.items[0].title === 'owner');
  check('owner sees the waiting count in /me', (await go('/me', { tok: 'tok-owner' })).body.pending === 3 && (await go('/me', { tok: 'tok-emp' })).body.pending === 0);
  const n = await go('/knowledge/note', { method: 'POST', tok: 'tok-emp', type: 'application/json', body: JSON.stringify({ title: 'T', text: 'body' }) });
  check('employee adds a note: waiting', n.status === 200 && n.body.status === 'pending');
  check('note errors come back plainly', (await go('/knowledge/note', { method: 'POST', tok: 'tok-emp', type: 'application/json', body: JSON.stringify({ text: 'x' }) })).body.message === 'Give it a short title.');
  const up = await go('/knowledge/upload?name=' + encodeURIComponent('price list.csv') + '&title=' + encodeURIComponent('Prices'), { method: 'POST', tok: 'tok-emp', type: 'application/octet-stream', body: Buffer.from('a,b\n1,2') });
  check('upload: file arrives as-is with its name and title', up.status === 200 && JSON.stringify(seen.at(-1)) === JSON.stringify(['file', 'employee', 'price list.csv', 'Prices', 7]), seen.at(-1));
  const n0 = seen.length;
  const anon = await go('/knowledge/upload?name=a.csv', { method: 'POST', type: 'application/octet-stream', body: Buffer.alloc(1024 * 1024, 65) });
  check('upload while signed out: refused before the file is read', anon.status === 401 && seen.length === n0);
  const big = await go('/knowledge/upload?name=a.csv', { method: 'POST', tok: 'tok-emp', type: 'application/octet-stream', body: Buffer.alloc(10 * 1024 * 1024 + 10, 65) });
  check('upload over 10 MB: refused with a plain message', big.status === 413 && /10 MB/.test(big.body.message) && seen.length === n0);
  const exe = await go('/knowledge/upload?name=run.exe', { method: 'POST', tok: 'tok-emp', type: 'application/octet-stream', body: Buffer.from('MZ') });
  check('bad file type: the reader\'s message is shown', exe.status === 400 && /isn’t supported/.test(exe.body.message));
  check('employee can\'t review', (await go('/knowledge/review', { method: 'POST', tok: 'tok-emp', type: 'application/json', body: JSON.stringify({ id: 'a', decision: 'approve' }) })).status === 403);
  check('owner reviews', (await go('/knowledge/review', { method: 'POST', tok: 'tok-owner', type: 'application/json', body: JSON.stringify({ id: 'a', decision: 'approve' }) })).body.status === 'approved');
  const dl = await go('/knowledge/file?id=f1', { tok: 'tok-owner' });
  check('download: always a download, never shown as a page', dl.status === 200 && dl.h.get('content-type') === 'application/octet-stream' && /^attachment;/.test(dl.h.get('content-disposition')) && dl.h.get('x-content-type-options') === 'nosniff' && /sandbox/.test(dl.h.get('content-security-policy')));
  check('download: the file name can\'t break the header', !/"[^"]*"[^;]*"/.test(dl.h.get('content-disposition')) && dl.h.get('content-disposition').includes("filename*=UTF-8''pr%22ice%20%C3%BC.csv"), dl.h.get('content-disposition'));
  check('download: the file comes back byte for byte', dl.body.toString() === '<script>alert(1)</script>');
  check('download: missing → 404', (await go('/knowledge/file?id=zzz', { tok: 'tok-owner' })).status === 404);
  const pre = await fetch(base + '/knowledge/upload', { method: 'OPTIONS', headers: { origin: 'https://www.co-optech.com', 'access-control-request-method': 'POST' } });
  check('the dashboard is allowed to call the upload route (preflight)', pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'https://www.co-optech.com');
} finally { srv.close(); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
