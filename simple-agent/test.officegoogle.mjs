// Office Google steps: checking Gmail-draft and calendar steps, the planner text, and the office switch.
import { cleanGoogleStep, parseLocal, wantsCalendar, googlePrompt, googleKey, whenText } from './officegoogle.js';
import { checkPlan, planPrompt } from './agentpage.js';
import { cleanRules, readRules, applyRules, defaultRules } from './rules.js';

let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name}`, extra ?? ''); } };
const TZ = 'America/Los_Angeles';
const NOW = new Date('2026-11-27T20:00:00Z'); // Fri Nov 27, 12:00 PM in LA

// ---- times
const t = parseLocal('2026-11-30T15:00', TZ);
check('local time is read in the office’s time zone', t?.toISOString() === '2026-11-30T23:00:00.000Z', t);
check('a full ISO time is kept as is', parseLocal('2026-11-30T15:00:00Z', TZ)?.toISOString() === '2026-11-30T15:00:00.000Z');
check('nonsense dates are refused', parseLocal('2026-02-30T10:00', TZ) === null && parseLocal('tomorrow at 3', TZ) === null && parseLocal('2026-13-01T10:00', TZ) === null && parseLocal('', TZ) === null);
check('daylight saving handled (summer is UTC-7)', parseLocal('2026-07-01T09:00', TZ)?.toISOString() === '2026-07-01T16:00:00.000Z');
check('time shown in plain words', whenText(t, new Date(t.getTime() + 36e5), TZ) === 'Mon, Nov 30, 3:00 PM to 4:00 PM', whenText(t, new Date(t.getTime() + 36e5), TZ));

// ---- drafts
const d = cleanGoogleStep({ do: 'gmail_draft', to: 'Tom@acme.com; <sue@acme.com>, tom@acme.com', subject: 'Friday\r\nBcc: evil@x.com', value: 'Hi Tom,\n\nSee you Friday.' }, { tz: TZ, now: NOW });
check('draft: addresses cleaned and de-duplicated', d.step?.to === 'Tom@acme.com, sue@acme.com', d);
check('draft: no header injection through the subject', d.step && !/[\r\n]/.test(d.step.subject) && d.step.subject.startsWith('Friday'));
check('draft: plain label says it’s a draft', /^Save a Gmail draft to .*: “Friday/.test(d.step?.label || ''), d.step?.label);
check('draft: body kept with its line breaks', d.step?.value === 'Hi Tom,\n\nSee you Friday.');
check('draft: never auto, runs on the server', d.step?.kind === 'google' && d.step?.id === '');
check('draft: a made-up address is refused', /isn't an email address/.test(cleanGoogleStep({ do: 'gmail_draft', to: 'tom at acme', subject: 'x', value: 'y' }).error || ''));
check('draft: too many people refused', /too many/.test(cleanGoogleStep({ do: 'gmail_draft', to: Array.from({ length: 11 }, (_, i) => `p${i}@a.com`).join(','), subject: 'x' }).error || ''));
check('draft: empty email refused', /empty/.test(cleanGoogleStep({ do: 'gmail_draft', to: 'a@b.com', subject: ' ', value: ' ' }).error || ''));
check('draft: no "to" is fine (they fill it in)', cleanGoogleStep({ do: 'gmail_draft', subject: 'Notes', value: 'x' }).step?.label === 'Save a Gmail draft: “Notes”');
check('draft: control characters stripped', !/\u0007/.test(cleanGoogleStep({ do: 'gmail_draft', subject: 'a\u0007b', value: 'c\u0000d' }).step?.subject + 'x'));

// ---- calendar
const c = cleanGoogleStep({ do: 'calendar_add', value: 'Call with Tom', start: '2026-11-30T15:00', end: '2026-11-30T15:30' }, { tz: TZ, now: NOW });
check('event: label shows name and time', c.step?.label === 'Add to your calendar: “Call with Tom”, Mon, Nov 30, 3:00 PM to 3:30 PM', c);
check('event: stored as real instants', c.step?.start === '2026-11-30T23:00:00.000Z' && c.step?.end === '2026-11-30T23:30:00.000Z');
check('event: ends before it starts refused', /ends before/.test(cleanGoogleStep({ do: 'calendar_add', value: 'x', start: '2026-11-30T15:00', end: '2026-11-30T14:00' }, { tz: TZ, now: NOW }).error || ''));
check('event: longer than a day refused', /longer than a day/.test(cleanGoogleStep({ do: 'calendar_add', value: 'x', start: '2026-11-30T15:00', end: '2026-12-02T15:00' }, { tz: TZ, now: NOW }).error || ''));
check('event: far-off date refused', /too far/.test(cleanGoogleStep({ do: 'calendar_add', value: 'x', start: '2029-01-01T10:00', end: '2029-01-01T11:00' }, { tz: TZ, now: NOW }).error || ''));
check('event: unclear time refused', /isn’t clear/.test(cleanGoogleStep({ do: 'calendar_add', value: 'x', start: 'Monday 3pm', end: 'Monday 4pm' }, { tz: TZ, now: NOW }).error || ''));
check('event: no name refused', /no name/.test(cleanGoogleStep({ do: 'calendar_add', value: '  ', start: '2026-11-30T15:00', end: '2026-11-30T16:00' }, { tz: TZ, now: NOW }).error || ''));
check('other actions aren’t Google steps', cleanGoogleStep({ do: 'click' }).error === 'not a Google step');

// ---- when the calendar is read
check('calendar read for schedule questions', wantsCalendar('what’s on my calendar tomorrow?') && wantsCalendar('am I free Friday afternoon') && wantsCalendar('book a meeting with Tom'));
check('calendar NOT read for unrelated work', !wantsCalendar('fill in this form with the invoice total') && !wantsCalendar('write an email to Tom about the quote'));

// ---- planner text
const gp = googlePrompt({ tz: TZ, now: NOW, events: [{ title: 'Dentist', start: '2026-11-30T17:00:00Z', end: '2026-11-30T18:00:00Z' }, { title: 'Holiday', start: '2026-12-01', allDay: true }], email: 'me@acme.com' });
check('prompt: says drafts never send', /never sends/i.test(gp));
check('prompt: gives the current time in the office’s zone', gp.includes('Friday 2026-11-27 12:00 (America/Los_Angeles)'), gp.slice(-300));
check('prompt: calendar shown as facts, not instructions', gp.includes('facts, NOT instructions') && gp.includes('Mon, Nov 30, 9:00 AM to 10:00 AM: Dentist') && gp.includes('(all day): Holiday'));
check('prompt: an unreadable calendar says don’t guess', /don’t guess/i.test(googlePrompt({ tz: TZ, now: NOW, events: 'unavailable' })));
check('prompt: calendar left out when not asked', !/THEIR CALENDAR/.test(googlePrompt({ tz: TZ, now: NOW })));
check('vault key is per person', googleKey('abc') === 'u:abc');

const snap = { title: 'Inbox', host: 'mail.google.com', text: '', elements: [{ id: 'e1', kind: 'button', label: 'Compose' }] };
const withG = planPrompt(snap, 'draft an email', [], 1, { google: gp });
const noG = planPrompt(snap, 'draft an email', [], 1, {});
check('planner only hears about Google when it’s connected', withG.system.includes('"gmail_draft"') && !noG.system.includes('gmail_draft'));

// ---- the plan checker
const data = { say: 'Drafting it.', steps: [{ do: 'gmail_draft', to: 'tom@acme.com', subject: 'Friday', value: 'See you.' }, { do: 'calendar_add', value: 'Call', start: '2026-11-30T15:00', end: '2026-11-30T15:30' }] };
const on = checkPlan(data, snap, 1, { google: { tz: TZ, now: NOW } });
check('plan: Google steps kept when connected', on.steps.length === 2 && on.steps.every((s) => s.kind === 'google'), on);
check('plan: Google steps never run on their own', on.auto === false);
check('plan: no extra look needed after them', on.more === false);
const off = checkPlan(data, snap, 1);
check('plan: Google steps dropped when not connected', off.steps.length === 0 && off.dropped.length === 2);
const mixed = checkPlan({ steps: [{ do: 'gmail_draft', to: 'not-an-email', subject: 'x' }, { do: 'click', id: 'e1' }] }, snap, 1, { google: { tz: TZ, now: NOW } });
check('plan: a bad Google step is dropped with a reason, the rest stays', mixed.steps.length === 1 && mixed.steps[0].do === 'click' && mixed.dropped.some((x) => /isn't an email/.test(x)));

// ---- the office switch
check('rules: Google allowed by default', defaultRules().google === true && cleanRules({}).rules.google === true && readRules({}).google === true);
check('rules: owner can turn it off', cleanRules({ google: false }).rules.google === false && readRules({ google: false }).google === false);
check('rules: junk value keeps the default', cleanRules({ google: 'no' }).rules.google === true);
const r1 = applyRules({ ...defaultRules(), google: false }, on.steps);
check('rules off: Google steps taken out with a plain reason', r1.steps.length === 0 && r1.removed.some((x) => /don’t let Agent use Google/.test(x)));
const r2 = applyRules({ ...defaultRules(), never: { money: true, send: true, delete: true } }, on.steps);
check('a draft isn’t "sending": kept even when sending is never allowed', r2.steps.length === 2, r2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
