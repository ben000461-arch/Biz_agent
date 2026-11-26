// An office's employees are linked to the owner's business (so the Agent extension works for them),
// but must never get the owner's agent: chat, calendar, connections, billing, account.
import { createWebAuth } from './webchat.js';
let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra ?? ''); } };
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWNER = U(1), EMP = U(2), SOLO = U(3), REMOVED = U(4), TWO = U(5);
let tenantRows = { [OWNER]: '100', [EMP]: '100', [SOLO]: '200', [REMOVED]: '100', [TWO]: '300' };
let members = [
  { user_id: OWNER, chat_id: '100', role: 'owner', status: 'active' },
  { user_id: EMP, chat_id: '100', role: 'employee', status: 'active' },
  { user_id: REMOVED, chat_id: '100', role: 'employee', status: 'removed' },
  { user_id: TWO, chat_id: '300', role: 'owner', status: 'active' }, { user_id: TWO, chat_id: '900', role: 'employee', status: 'active' },
];
let officeMode = 'ok'; let calls = 0;
const fetchImpl = async (url) => {
  calls++;
  const u = new URL(url); const uid = (u.searchParams.get('user_id') || '').replace('eq.', '');
  if (u.pathname.endsWith('/tenant_users')) return new Response(JSON.stringify(tenantRows[uid] ? [{ chat_id: tenantRows[uid] }] : []), { status: 200 });
  if (u.pathname.endsWith('/office_members')) {
    if (officeMode === 'missing') return new Response('{"code":"PGRST205","message":"Could not find the table"}', { status: 404 });
    if (officeMode === 'down') return new Response('oops', { status: 500 });
    return new Response(JSON.stringify(members.filter((m) => m.user_id === uid && m.status === 'active').map(({ role, chat_id }) => ({ role, chat_id }))), { status: 200 });
  }
  return new Response('[]', { status: 404 });
};
const fresh = () => createWebAuth({ url: 'https://sb.test', key: 'sb_secret_x', fetchImpl, linkTtlMs: 60000 });
let a = fresh();
check('owner: gets their business everywhere', (await a.chatFor(OWNER)).chatId === '100' && (await a.chatFor(OWNER, { agent: true })).chatId === '100');
const e = await a.chatFor(EMP);
check('employee: NOT given the owner\'s business for chat / calendar / billing / connections', e.error === 'employee' && !e.chatId, e);
check('employee: still works for the Agent extension', (await a.chatFor(EMP, { agent: true })).chatId === '100');
check('someone with no office: unchanged', (await a.chatFor(SOLO)).chatId === '200');
check('a removed employee row doesn\'t make an owner into an employee (and is not an employee)', (await a.chatFor(REMOVED)).chatId === '100');
check('only the office for THIS link counts (owner of 300, employee elsewhere)', (await a.chatFor(TWO)).chatId === '300');
check('not linked at all: unlinked', (await a.chatFor(U(9))).error === 'unlinked');
a = fresh(); officeMode = 'down';
check('office lookup failing: stop (fail closed), never guess', (await a.chatFor(EMP)).error === 'unavailable' && (await a.chatFor(OWNER)).error === 'unavailable');
a = fresh(); officeMode = 'missing';
check('a setup without office tables: everyone works as before', (await a.chatFor(OWNER)).chatId === '100' && (await a.chatFor(SOLO)).chatId === '200');
a = fresh(); officeMode = 'ok';
await a.chatFor(EMP); const before = calls; const again = await a.chatFor(EMP);
check('cached: the employee answer is remembered, not re-asked each time', calls === before && again.error === 'employee');
a.forgetLink(EMP); members = members.filter((m) => m.user_id !== EMP); delete tenantRows[EMP];
check('after removal (link deleted + forgotten): no business at all', (await a.chatFor(EMP, { agent: true })).error === 'unlinked');
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
