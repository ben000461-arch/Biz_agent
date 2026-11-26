// Office rules: cleaning what the owner types, matching sites, and taking forbidden steps out of plans.
import { defaultRules, normHost, hostIn, cleanRules, readRules, siteProblem, stepKinds, applyRules } from './rules.js';
let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); } };
const d = defaultRules();

check('defaults: any site, small steps run on their own, never pay', d.sites.mode === 'any' && d.approval === 'small' && d.never.money === true && !d.never.send && !d.never.delete);
check('site names cleaned from whatever is pasted', normHost('https://www.Chase.com/login?x=1') === 'chase.com' && normHost('*.google.com') === 'google.com' && normHost('mail.google.com:443') === 'mail.google.com' && normHost('user@evil.com/x') === 'evil.com');
check('not sites: refused', ['', 'hello', 'localhost', 'a b.com', 'javascript:alert(1)', '127.0.0.1', '-x.com'].every((x) => normHost(x) === ''));
check('a listed site covers its sub-sites, not look-alikes', hostIn('mail.google.com', ['google.com']) && !hostIn('notgoogle.com', ['google.com']) && !hostIn('google.com.evil.io', ['google.com']));
let c = cleanRules({ sites: { mode: 'any', allow: [], block: ['https://Chase.com/', 'chase.com', 'wellsfargo.com'] }, approval: 'task', never: { money: false, send: true }, extra: 'dropped' });
check('clean rules: duplicates merged, sorted, unknown fields dropped, missing ones defaulted', c.rules && JSON.stringify(c.rules.sites.block) === '["chase.com","wellsfargo.com"]' && c.rules.approval === 'task' && c.rules.never.money === false && c.rules.never.send === true && c.rules.never.delete === false && !('extra' in c.rules), c);
check('a bad site is named in the error', cleanRules({ sites: { block: ['good.com', 'not a site'] } }).site === 'not a site');
check('"only these sites" with none listed: refused (Agent could work nowhere)', cleanRules({ sites: { mode: 'only', allow: [] } }).error === 'empty_allow');
check('over 100 sites refused', cleanRules({ sites: { block: Array.from({ length: 101 }, (_, i) => `s${i}.com`) } }).error === 'too_many_sites');
check('unknown approval setting: falls back to the default', cleanRules({ approval: 'yolo' }).rules.approval === 'small');
check('odd stored rules never crash; sound parts kept', (() => { const r = readRules({ sites: { mode: 'only', allow: [], block: ['ok.com', null, 'bad site'] }, approval: 'every', never: { send: true, money: 'yes' } }); return r.sites.mode === 'any' && JSON.stringify(r.sites.block) === '["ok.com"]' && r.approval === 'every' && r.never.send === true && r.never.money === true; })());
check('nothing stored = defaults', JSON.stringify(readRules(null)) === JSON.stringify(d) && JSON.stringify(readRules(undefined)) === JSON.stringify(d));
const only = { ...d, sites: { mode: 'only', allow: ['google.com'], block: ['drive.google.com'] } };
check('only-these-sites: listed ok, others refused', siteProblem(only, 'https://docs.google.com/x') === '' && /only allow/.test(siteProblem(only, 'https://example.com')));
check('blocked beats allowed', /don’t allow Agent on drive\.google\.com/.test(siteProblem(only, 'https://drive.google.com/')));
check('odd page addresses don\'t trip it', siteProblem(only, 'chrome://extensions') === '' && siteProblem(only, '') === '');
// what kind of step is it?
const k = (st) => [...stepKinds(st)].sort().join(',');
check('money: pay / checkout / add to cart / card fields', k({ do: 'click', label: 'Pay now' }) === 'money' && k({ do: 'click', label: 'Proceed to checkout' }) === 'money' && k({ do: 'click', label: 'Add to cart' }) === 'money' && k({ do: 'fill', label: 'Card number' }) === 'money' && k({ do: 'fill', label: 'CVV' }) === 'money');
check('send: send / reply / post / a form submit (not a search)', k({ do: 'click', label: 'Send' }) === 'send' && k({ do: 'click', label: 'Reply all' }) === 'send' && k({ do: 'submit', label: 'Message' }) === 'send' && k({ do: 'submit', label: 'Search mail' }) === '');
check('delete: delete / trash / archive / clearing a document', k({ do: 'click', label: 'Move to trash' }) === 'delete' && k({ do: 'click', label: 'Archive' }) === 'delete' && k({ do: 'clear', label: 'Body' }) === 'delete');
check('ordinary steps are none of these', ['Save', 'Bold', 'New slide', 'Compose', 'Next page', 'Sender name'].every((l) => k({ do: 'click', label: l }) === '') && k({ do: 'fill', label: 'Subject' }) === '');
const steps = [{ do: 'click', label: 'Bold' }, { do: 'click', label: 'Pay now' }, { do: 'fill', label: 'Card number', value: '4111' }];
let a = applyRules(d, steps);
check('applyRules: money steps out (one reason each), the rest kept', a.steps.length === 1 && a.steps[0].label === 'Bold' && a.removed.length === 2 && a.removed.every((x) => /pay, buy/.test(x)));
a = applyRules({ ...d, never: { money: false, send: false, delete: false } }, steps);
check('with "never pay" switched off, nothing is removed', a.steps.length === 3 && !a.removed.length);
a = applyRules({ ...d, sites: { mode: 'any', allow: [], block: ['chase.com'] } }, [{ do: 'open', value: 'https://secure.chase.com/' }, { do: 'switch', label: 'Inbox (mail.google.com)' }, { do: 'switch', label: 'Bank (www.chase.com)' }]);
check('open/switch to a blocked site removed; other tabs fine', a.steps.length === 1 && /mail\.google/.test(a.steps[0].label) && a.removed.length === 2, a);
check('approval settings: small = may auto; task = no auto; every = no auto + ask every batch', !applyRules(d, []).noAuto && applyRules({ ...d, approval: 'task' }, []).noAuto && !applyRules({ ...d, approval: 'task' }, []).askEvery && applyRules({ ...d, approval: 'every' }, []).askEvery);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
