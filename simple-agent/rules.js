// Office rules: what an office's owner allows Agent to do. Kept on the business (office_businesses.rules)
// and enforced HERE, on the agent server, for everyone in that office (an employee can't get around them):
//
//   sites     where Agent may work: anywhere, or only listed sites; plus sites it may never touch
//   approval  'small' = small, safe steps may run on their own (the extension's default)
//             'task'  = ask once per task (no step runs without a yes)
//             'every' = ask before every batch of steps, even later rounds of an approved task
//   never     kinds of actions Agent may never take: paying/buying, sending, deleting
//   google    may people connect their OWN Google, so Agent can save Gmail drafts and add calendar events
//
// A blocked site stops planning before any AI call. Forbidden steps are taken out of a plan before the
// extension ever sees them, with a plain reason.

export const APPROVAL = ['small', 'task', 'every'];
export const NEVER = ['money', 'send', 'delete'];
export const MAX_SITES = 100;
export const GOOGLE_STEPS = new Set(['gmail_draft', 'calendar_add']); // run by the agent server with the person's own Google

export function defaultRules() {
  return { sites: { mode: 'any', allow: [], block: [] }, approval: 'small', never: { money: true, send: false, delete: false }, google: true };
}

// "https://www.Chase.com/login" -> "chase.com". -> '' when it isn't a site name.
export function normHost(v) {
  let s = String(v ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^[^@/]*@/, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
  if (s.length > 253 || !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(s)) return '';
  return s;
}
// a listed site covers itself and everything under it: "google.com" covers "mail.google.com"
export const hostIn = (host, list) => {
  const h = normHost(host);
  return !!h && (list || []).some((x) => h === x || h.endsWith(`.${x}`));
};

// What the owner sent -> clean rules, or { error }. Unknown fields are dropped.
export function cleanRules(input) {
  const d = defaultRules();
  const inp = input && typeof input === 'object' ? input : {};
  const lists = {};
  for (const k of ['allow', 'block']) {
    const raw = Array.isArray(inp.sites?.[k]) ? inp.sites[k] : [];
    if (raw.length > MAX_SITES) return { error: 'too_many_sites' };
    const bad = raw.filter((x) => !normHost(x)).map((x) => String(x).slice(0, 60));
    if (bad.length) return { error: 'bad_site', site: bad[0] };
    lists[k] = [...new Set(raw.map(normHost))].sort();
  }
  const mode = inp.sites?.mode === 'only' ? 'only' : 'any';
  if (mode === 'only' && !lists.allow.length) return { error: 'empty_allow' };
  const approval = APPROVAL.includes(inp.approval) ? inp.approval : d.approval;
  const never = Object.fromEntries(NEVER.map((k) => [k, typeof inp.never?.[k] === 'boolean' ? inp.never[k] : d.never[k]]));
  const google = typeof inp.google === 'boolean' ? inp.google : d.google;
  return { rules: { sites: { mode, allow: lists.allow, block: lists.block }, approval, never, google } };
}

// Stored value (maybe old or partly missing) -> full rules, never throws
export function readRules(stored) {
  const c = cleanRules(stored);
  if (c.rules) return c.rules;
  // something odd got stored: keep what's sound, fall back to defaults for the rest
  const d = defaultRules();
  const keep = (list) => (Array.isArray(list) ? [...new Set(list.map(normHost).filter(Boolean))].slice(0, MAX_SITES) : []);
  const allow = keep(stored?.sites?.allow), block = keep(stored?.sites?.block);
  return { ...d, sites: { mode: stored?.sites?.mode === 'only' && allow.length ? 'only' : 'any', allow, block }, approval: APPROVAL.includes(stored?.approval) ? stored.approval : d.approval, never: { ...d.never, ...Object.fromEntries(NEVER.filter((k) => typeof stored?.never?.[k] === 'boolean').map((k) => [k, stored.never[k]])) }, google: typeof stored?.google === 'boolean' ? stored.google : d.google };
}

// May Agent work on this page? -> '' or the reason it may not
export function siteProblem(rules, url) {
  let host = '';
  try { host = new URL(String(url || '')).hostname; } catch { host = ''; }
  const h = normHost(host);
  if (!h) return ''; // not a normal web page; the extension doesn't run there anyway
  if (hostIn(h, rules.sites.block)) return `Your office’s rules don’t allow Agent on ${h}.`;
  if (rules.sites.mode === 'only' && !hostIn(h, rules.sites.allow)) return `Your office’s rules only allow Agent on certain sites, and ${h} isn’t one of them.`;
  return '';
}

// What kind of action is this step? (labels of buttons/fields, as the planner saw them)
const MONEY_CLICK = /\b(pay|payment|buy|purchase|checkout|check out|place (?:your )?order|order now|add to (?:cart|bag|basket)|transfer|send money|donate|tip|subscribe|upgrade|renew|book now|confirm (?:purchase|payment|booking))\b/i;
const MONEY_FIELD = /\b(card ?number|credit card|debit card|cvv|cvc|security code|expir(?:y|ation)|routing( number)?|account number|iban|swift|bank account|amount to (?:pay|send|transfer))\b/i;
const SEND_CLICK = /\b(send|submit|post|publish|share|reply|reply all|forward|tweet|comment|invite|schedule send)\b/i;
const DELETE_CLICK = /\b(delete|remove|trash|discard|erase|clear all|empty trash|archive|deactivate|cancel (?:account|subscription))\b/i;
export function stepKinds(st) {
  const label = String(st?.label || '');
  const kinds = new Set();
  const clicky = st?.do === 'click' || st?.do === 'submit';
  if ((clicky && MONEY_CLICK.test(label)) || ((st?.do === 'fill' || st?.do === 'replace') && MONEY_FIELD.test(label))) kinds.add('money');
  if ((st?.do === 'click' && SEND_CLICK.test(label)) || (st?.do === 'submit' && !/search/i.test(label))) kinds.add('send');
  if ((st?.do === 'click' && DELETE_CLICK.test(label)) || st?.do === 'clear') kinds.add('delete');
  return kinds;
}
const NEVER_SAY = { money: 'pay, buy or enter payment details', send: 'send or post things', delete: 'delete things' };

// Take forbidden steps out of a plan. -> { steps, removed: [reasons], askEvery, noAuto }
export function applyRules(rules, steps) {
  const kept = [], removed = [];
  for (const st of steps || []) {
    // going to another site: the site rules apply there too
    if (st.do === 'open' || st.do === 'switch') {
      const tabHost = (/\(([^()\s]+\.[a-z]{2,})\)\s*$/i.exec(st.label || '') || [])[1]; // tabs are listed as Title (host)
      const target = st.do === 'open' ? st.value : tabHost ? `https://${tabHost}` : '';
      const why = target ? siteProblem(rules, target) : '';
      if (why) { removed.push(why); continue; }
    }
    if (GOOGLE_STEPS.has(st.do) && rules.google === false) { removed.push('Your office’s rules don’t let Agent use Google accounts.'); continue; }
    const hit = [...stepKinds(st)].find((k) => rules.never[k]);
    if (hit) { removed.push(`Your office’s rules don’t let Agent ${NEVER_SAY[hit]} (“${String(st.label || '').slice(0, 60)}”).`); continue; }
    kept.push(st);
  }
  return { steps: kept, removed: [...new Set(removed)], askEvery: rules.approval === 'every', noAuto: rules.approval !== 'small' };
}
