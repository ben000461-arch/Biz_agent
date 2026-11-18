// when.js — reads dates, times and schedules out of plain words, in the CUSTOMER's time zone.
//
// Code does this, never the model: a small model will happily invent "3 PM Tuesday". Everything here is a pure
// function (give it `now` and a time zone, get an answer), so it is easy to test and the same words always mean
// the same time.
//
//   parseWhen("schedule a call with Tom tomorrow at 3")  -> { start, hasDay, hasTime, vague, rolled, past }
//   parseSchedule("every weekday at 8am")                -> { kind:'daily', time:'08:00', days:[1,2,3,4,5] }
//   dueAt(schedule, { now, tz, since })                  -> the moment a schedule last came due (or null)

export const DEFAULT_GRACE_MS = 3 * 60 * 60 * 1000; // a run that is more than 3 hours late is skipped, not run at a silly time

// ---------------------------------------------------------------- time zones
const fmtCache = new Map();
function dtf(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
  }
  return fmtCache.get(tz);
}
export function validTz(tz) {
  if (typeof tz !== 'string' || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$|^UTC$/.test(tz)) return false;
  try { dtf(tz); return true; } catch { return false; }
}
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
// -> { y, m (1-12), d, h, mi, s, dow (0=Sunday) } as the wall clock reads in `tz`
export function zonedParts(date, tz) {
  const o = {};
  for (const p of dtf(tz).formatToParts(date)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, dow: DOW[o.weekday] };
}
const offsetAt = (ms, tz) => { const p = zonedParts(new Date(ms), tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000; };
// wall-clock time in `tz` -> the real instant (handles daylight saving)
export function zonedToUtc({ y, m, d, h = 0, mi = 0 }, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const o1 = offsetAt(guess, tz);
  let t = guess - o1;
  const o2 = offsetAt(t, tz);
  if (o2 !== o1) t = guess - o2;
  return new Date(t);
}
const addDays = (parts, n) => { const dt = new Date(Date.UTC(parts.y, parts.m - 1, parts.d + n)); return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), dow: dt.getUTCDay() }; };

// ---------------------------------------------------------------- showing times
const MONTHS3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const clock12 = (h, mi) => `${h % 12 || 12}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
export const timeLabel = (hhmm) => { const [h, mi] = String(hhmm).split(':').map(Number); return clock12(h, mi); };
// "Mon Oct 26 at 3:00 PM"
export function formatWhen(date, tz) {
  const p = zonedParts(date, tz);
  return `${DAYS3[p.dow]} ${MONTHS3[p.m - 1]} ${p.d} at ${clock12(p.h, p.mi)}`;
}
// "PDT", "EST"… for the zone at that moment (so a confirmation can say which clock it means)
export function tzAbbrev(date, tz) {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || tz; } catch { return tz; }
}
// "booking" words: is this message a command to put something on the calendar (not a question about it)?
const POLITE_RE = /^(?:(?:hey|hi|ok|okay|so|yes|yeah|yep|yup|and|also|then|please|pls|can you|could you|would you|can we|let'?s|lets|i need (?:you )?to|i want (?:you )?to|i'?d like (?:you )?to|go ahead and)[,.!]?\s+)+/i;
const EVENT_NOUN_RE = /\b(meeting|call|appointment|event|interview|lunch|dinner|visit|demo|session|estimate|inspection|consultation|reservation|showing|install(?:ation)?|delivery|pickup|haircut|checkup)\b/i;
const TIMEISH_RE = /\b(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|noon|midnight|at\s+\d|tomorrow|tmrw|today|tonight|(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*|jan[a-z]*|feb[a-z]*|mar[a-z]*|apr[a-z]*|may|jun[a-z]*|jul[a-z]*|aug[a-z]*|sep[a-z]*|oct[a-z]*|nov[a-z]*|dec[a-z]*|\d{1,2}\/\d{1,2})\b/i;

// "Schdule", "sheduel", "scedule"… a typo in the first word still means schedule
const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1] ? d[i - 2][j - 2] + 1 : 9); return d[a.length][b.length]; };
const isScheduleTypo = (w) => { const x = w.toLowerCase(); return x !== 'schedule' && x.length >= 5 && x.length <= 10 && x[0] === 's' && !/^schedul(es|ed|ing)$/.test(x) && lev(x, 'schedule') <= 2; };
export function fixBookingTypos(text) {
  const t = String(text || '');
  const m = /^((?:(?:hey|hi|ok|okay|so|yes|yeah|yep|yup|and|also|then|please|pls)[,.!]?\s+)*)([A-Za-z]+)\b/.exec(t.trim());
  if (!m || !isScheduleTypo(m[2])) return t;
  return t.trim().replace(m[0], `${m[1]}schedule`);
}
const CLOCKISH_RE = /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)(?![a-z])|\bat\s+\d{1,2}\b|\b\d{1,2}:\d{2}\b|\b(?:noon|midnight)\b/i;
export function looksLikeBooking(text) {
  const t = fixBookingTypos(String(text || '').trim().replace(/\s+/g, ' '));
  if (!t || t.length > 300) return false;
  const s = t.replace(POLITE_RE, '');
  if (/^(what|what'?s|whats|when|which|who|why|how|do|does|did|is|are|was|am|show|list|tell|any|check|see|view)\b/i.test(s)) return false;
  const hasCal = /\bcalendar\b/i.test(s);
  const other = /\b(agent|reminder|spreadsheet|sheet|excel|file|note|notes|email|e-mail|list)\b/i.test(s); // something else they want made, not a calendar entry
  if (other && !hasCal) return false;
  if (/^(schedule|book|reserve|arrange|set up|setup|slot in)\b/i.test(s)) return true;
  if (/^(add|put|create|block(?: off)?|plan|make)\b/i.test(s)) return hasCal || (EVENT_NOUN_RE.test(s) && TIMEISH_RE.test(s));
  // no verb at all: "lunch with Dana at 3", "a meeting tomorrow at 3pm with Diane" — a thing and a time, said as a short statement
  const bare = s.replace(/^(?:a|an|the|my)\s+/i, '');
  if (s.length <= 120 && EVENT_NOUN_RE.test(bare) && CLOCKISH_RE.test(bare) && TIMEISH_RE.test(bare) && !/[?]\s*$/.test(s)) return true;
  return false;
}
// ---------------------------------------------------------------- reading a clock time
const periodOf = (t) => (/\b(tonight|this evening|evening|night|afternoon)\b/.test(t) ? 'pm' : /\bmorning\b/.test(t) ? 'am' : null);
function resolveVague(h, period) {
  if (h >= 13) return h;
  if (period === 'pm') return h < 12 ? h + 12 : h;
  if (period === 'am') return h === 12 ? 0 : h;
  if (h === 12) return 12;
  if (h >= 7 && h <= 11) return h; // "at 9" in a business means morning
  if (h >= 1 && h <= 6) return h + 12; // "at 3" means afternoon
  return h;
}
// -> { h, mi, vague } | null.   vague = they gave no am/pm, so we guessed (and the confirmation will say what we guessed)
export function parseClock(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(noon|midday)\b/.test(t)) return { h: 12, mi: 0, vague: false };
  if (/\bmidnight\b/.test(t)) return { h: 0, mi: 0, vague: false };
  let m = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/.exec(t);
  if (m) {
    const h12 = +m[1], mi = m[2] ? +m[2] : 0;
    if (h12 < 1 || h12 > 12 || mi > 59) return null;
    const pm = m[3][0] === 'p';
    return { h: (h12 % 12) + (pm ? 12 : 0), mi, vague: false };
  }
  m = /\b(?:at|@|by|around|from)\s*(\d{1,2})(?::(\d{2}))?(?![\d:]|\s*(?:people|guys|%|dollars|bucks|units|items|times|miles|min|mins|minutes|hour|hours|hr|hrs)\b)/.exec(t);
  if (!m) { const c = /\b(\d{1,2}):(\d{2})\b/.exec(t); m = c; }
  if (m) {
    const h = +m[1], mi = m[2] ? +m[2] : 0;
    if (h > 23 || mi > 59) return null;
    return { h: resolveVague(h, periodOf(t)), mi, vague: h < 13 && h !== 0 };
  }
  return null;
}

// ---------------------------------------------------------------- reading a day
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const monthIndex = (s) => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(s.slice(0, 3)) + 1;
// -> { y, m, d, dow, sameDayWeekday? } | null
export function parseDay(text, { now = new Date(), tz }) {
  const t = String(text || '').toLowerCase();
  const today = zonedParts(now, tz);
  const base = { y: today.y, m: today.m, d: today.d };
  const real = (y, m, d) => { const dt = new Date(Date.UTC(y, m - 1, d)); return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? { y, m, d, dow: dt.getUTCDay() } : null; };
  const future = (m, d, y) => { // a date with no year: this year, unless that day has already passed
    let r = real(y ?? today.y, m, d);
    if (r && y == null && Date.UTC(r.y, r.m - 1, r.d) < Date.UTC(today.y, today.m - 1, today.d)) r = real(today.y + 1, m, d);
    return r;
  };
  let m = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(t);
  if (m) { const r = future(monthIndex(m[1]), +m[2]); if (r) return r; }
  m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b`).exec(t);
  if (m) { const r = future(monthIndex(m[2]), +m[1]); if (r) return r; }
  m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t);
  if (m) { const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : undefined; const r = future(+m[1], +m[2], y); if (r) return r; }
  if (/\bday after tomorrow\b/.test(t)) return addDays(base, 2);
  if (/\b(tomorrow|tmrw|tmr)\b/.test(t)) return addDays(base, 1);
  if (/\b(today|tonight|this (?:morning|afternoon|evening))\b/.test(t)) return addDays(base, 0);
  m = /\b(?:(next|this|on)\s+)?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|sday|nesday|rsday|urday)?s?\b/.exec(t);
  if (m) {
    const target = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[m[2].slice(0, 3)];
    let diff = (target - today.dow + 7) % 7;
    if (m[1] === 'next' && diff === 0) diff = 7;
    const r = addDays(base, diff);
    return diff === 0 ? { ...r, sameDayWeekday: true } : r;
  }
  return null;
}

// ---------------------------------------------------------------- a moment: "tomorrow at 3", "in 2 hours"
// -> { start: Date|null, hasDay, hasTime, vague, rolled, past } | null
export function parseWhen(text, { now = new Date(), tz }) {
  const t = String(text || '').toLowerCase();
  const rel = /\bin\s+(\d+(?:\.\d+)?|an?|half an?)\s*(minutes?|mins?|hours?|hrs?)\b/.exec(t);
  if (rel) {
    const n = rel[1] === 'a' || rel[1] === 'an' ? 1 : rel[1].startsWith('half') ? 0.5 : parseFloat(rel[1]);
    const ms = n * (/^h/.test(rel[2]) ? 3600000 : 60000);
    if (ms >= 60000 && ms <= 14 * 864e5) return { start: new Date(Math.ceil((now.getTime() + ms) / 60000) * 60000), hasDay: true, hasTime: true, vague: false, rolled: false, past: false, relative: true };
  }
  const clock = parseClock(t);
  const day = parseDay(t, { now, tz });
  if (!clock && !day) return null;
  if (!clock) return { start: null, hasDay: true, hasTime: false, vague: false, rolled: false, past: false, day };
  const today = zonedParts(now, tz);
  let d = day || { y: today.y, m: today.m, d: today.d };
  let start = zonedToUtc({ y: d.y, m: d.m, d: d.d, h: clock.h, mi: clock.mi }, tz);
  let rolled = false;
  if (!day && start <= now) { d = addDays(d, 1); start = zonedToUtc({ ...d, h: clock.h, mi: clock.mi }, tz); rolled = true; }
  else if (day?.sameDayWeekday && start <= now) { d = addDays(d, 7); start = zonedToUtc({ ...d, h: clock.h, mi: clock.mi }, tz); rolled = true; }
  return { start, hasDay: Boolean(day), hasTime: true, vague: clock.vague, rolled, past: start.getTime() < now.getTime() - 5 * 60000 };
}

// "for 30 minutes", "an hour", "45 min" -> minutes (5..720) | null
export function parseDuration(text) {
  const t = String(text || '').toLowerCase();
  if (/\bhalf (an )?hour\b|\bhalf-hour\b/.test(t)) return 30;
  const m = /\b(?:for\s+)?(\d+(?:\.\d+)?|an?)[\s-]*(hours?|hrs?|h|minutes?|mins?|m)\b(?!\w)/.exec(t);
  if (!m || (!/\bfor\b/.test(m[0]) && !/\b(long|meeting|call|session|appointment|block)\b/.test(t) && !/^(minutes?|mins?|hours?|hrs?)$/.test(m[2]))) return null;
  const n = m[1] === 'a' || m[1] === 'an' ? 1 : parseFloat(m[1]);
  const min = Math.round(n * (/^h/.test(m[2]) ? 60 : 1));
  return min >= 5 && min <= 720 ? min : null;
}

// A title for the calendar, from THEIR words: "schedule a meeting with Tom at 3" -> "Meeting with Tom".
export function deriveTitle(text) {
  let t = String(text || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(?:(?:hey|hi|ok|okay|so|please|can you|could you|would you|can we|let'?s|i need (?:you )?to|i want (?:you )?to|i'?d like (?:you )?to)\s+)+/i, '');
  t = t.replace(/^(?:schedule|book|set up|setup|add|put|create|block(?: off)?|reserve|arrange|plan|slot in|make)\s+(?:in\s+)?(?:an?\s+|the\s+|my\s+|our\s+)?/i, '');
  t = t.replace(/\s+(?:on|in|to|onto)\s+(?:my|our|the)\s+(?:google\s+)?calendar\b/i, '');
  t = t.replace(/\b(?:for\s+)?(?:\d+(?:\.\d+)?|an?|half an?)[\s-]*(?:hours?|hrs?|minutes?|mins?)(?:\s+long)?\b/ig, ' ');
  t = t.replace(new RegExp(`\\b(?:on\\s+)?${MONTH_RE}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b|\\b\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?\\b`, 'ig'), ' ');
  t = t.replace(/\b(?:day after tomorrow|tomorrow|tmrw|today|tonight|this (?:morning|afternoon|evening)|(?:next|this|on)\s+(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*|(?:sun|mon|tue|tues|wed|thu|thurs|fri|sat)(?:day|sday|nesday|rsday|urday))\b/ig, ' ');
  t = t.replace(/\b(?:at|@|by|around|from)?\s*\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b|\b(?:at|@|by|around|from)\s*\d{1,2}(?::\d{2})?\b|\b(?:at\s+)?(?:noon|midnight)\b|\bin\s+(?:\d+|an?)\s*(?:hours?|hrs?|minutes?|mins?)\b/ig, ' ');
  t = t.replace(/\b(?:please|for me|thanks|thank you)\b/ig, ' ').replace(/[,.!?]+/g, ' ').replace(/\s+(?:at|on|for|by|from|to|in)\s*$/i, '').replace(/\s+/g, ' ').trim();
  if (!t) return 'Event';
  t = t.slice(0, 80);
  return t[0].toUpperCase() + t.slice(1);
}

// ---------------------------------------------------------------- schedules for agents
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// -> { kind:'daily', time:'08:00', days:[0-6] } | { kind:'once', at:ISO } | { kind:'before_event', minutes } | { kind:'manual' } | null
export function parseSchedule(text, { now = new Date(), tz }) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (/\b(only )?(when i (ask|say|tell)|on demand|manual(ly)?|no schedule|not on a schedule|never|run it myself|just when i)\b/.test(t)) return { kind: 'manual' };
  const rel = /\b(\d+(?:\.\d+)?|an?|half an?)\s*(minutes?|mins?|hours?|hrs?)\s+(?:before|ahead of|prior to)\s+(?:(?:every|each|all|any|my|the)\s+)?(?:calendar\s+)?(?:meeting|appointment|event|call|booking)s?\b/.exec(t);
  if (rel) {
    const n = rel[1] === 'a' || rel[1] === 'an' ? 1 : rel[1].startsWith('half') ? 0.5 : parseFloat(rel[1]);
    const minutes = Math.round(n * (/^h/.test(rel[2]) ? 60 : 1));
    return minutes >= 5 && minutes <= 240 ? { kind: 'before_event', minutes } : null;
  }
  if (/\bbefore\s+(?:every|each|all|any)\s+(?:calendar\s+)?(?:meeting|appointment|event|call|booking)s?\b/.test(t)) return { kind: 'before_event', minutes: 30 };
  const clock = parseClock(t);
  let days = null;
  if (/\b(every ?day|daily|each day|everyday|every (morning|afternoon|evening|night))\b/.test(t)) days = [0, 1, 2, 3, 4, 5, 6];
  else if (/\bweekdays?\b|\bmon(?:day)? ?(?:-|to|through|thru) ?fri(?:day)?\b/.test(t)) days = [1, 2, 3, 4, 5];
  else if (/\bweekends?\b/.test(t)) days = [0, 6];
  else {
    const names = [...t.matchAll(/\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|sday|nesday|rsday|urday)?(s?)\b/g)];
    const recurring = /\b(every|each)\b/.test(t) || names.some((n) => /(?:sun|mon|tues|wednes|thurs|fri|satur)days\b/.test(n[0]));
    if (names.length && recurring) days = [...new Set(names.map((n) => ({ sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[n[1].slice(0, 3)])))].sort();
  }
  if (days) {
    let time = null;
    if (clock) time = `${String(clock.h).padStart(2, '0')}:${String(clock.mi).padStart(2, '0')}`;
    else if (/\bmorning\b/.test(t)) time = '08:00';
    else if (/\bafternoon\b/.test(t)) time = '13:00';
    else if (/\bevening\b/.test(t)) time = '18:00';
    else if (/\bnight\b/.test(t)) time = '20:00';
    return time ? { kind: 'daily', time, days } : null;
  }
  const w = parseWhen(t, { now, tz });
  if (w?.hasTime && w.start && !w.past) return { kind: 'once', at: w.start.toISOString() };
  return null;
}
function describeDays(days) {
  const d = [...days].sort();
  if (d.length === 7) return 'every day';
  if (d.join() === '1,2,3,4,5') return 'every weekday';
  if (d.join() === '0,6') return 'every weekend';
  return `every ${d.map((x) => DAY_NAMES[x]).join(', ')}`;
}
export function describeSchedule(s, tz) {
  if (!s || s.kind === 'manual') return 'only when you ask';
  if (s.kind === 'once') return `once, ${formatWhen(new Date(s.at), tz)}`;
  if (s.kind === 'before_event') return `${s.minutes >= 60 && s.minutes % 60 === 0 ? `${s.minutes / 60} hour${s.minutes === 60 ? '' : 's'}` : `${s.minutes} minutes`} before each calendar event`;
  return `${describeDays(s.days)} at ${timeLabel(s.time)}`;
}

// The latest moment `schedule` came due that is after `since` and not too long ago (else null).
export function dueAt(s, { now = new Date(), tz, since = new Date(0), graceMs = DEFAULT_GRACE_MS }) {
  if (!s || s.kind === 'manual') return null;
  const nowMs = now.getTime();
  const ok = (d) => d.getTime() <= nowMs && nowMs - d.getTime() <= graceMs && d.getTime() > since.getTime();
  if (s.kind === 'once') { const at = new Date(s.at); return Number.isNaN(at.getTime()) ? null : ok(at) ? at : null; }
  if (s.kind !== 'daily' || !Array.isArray(s.days) || !/^\d{2}:\d{2}$/.test(s.time || '')) return null;
  const [h, mi] = s.time.split(':').map(Number);
  const today = zonedParts(now, tz);
  let best = null;
  for (const back of [0, 1]) {
    const day = addDays({ y: today.y, m: today.m, d: today.d }, -back);
    if (!s.days.includes(day.dow)) continue;
    const cand = zonedToUtc({ y: day.y, m: day.m, d: day.d, h, mi }, tz);
    if (ok(cand) && (!best || cand > best)) best = cand;
  }
  return best;
}

export function sameLocalDay(a, b, tz) { const x = zonedParts(a, tz), y = zonedParts(b, tz); return x.y === y.y && x.m === y.m && x.d === y.d; }

// "2026-10-26" in the zone's calendar
export function localDate(date, tz) { const p = zonedParts(date, tz); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; }
// midnight at the start of that day in the zone
export function startOfLocalDay(date, tz) { const p = zonedParts(date, tz); return zonedToUtc({ y: p.y, m: p.m, d: p.d }, tz); }
// a date picker's "2026-10-26" + a time picker's "15:30", read in the zone -> Date | null
export function fromLocal(dateStr, timeStr, tz) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '')), t = /^(\d{2}):(\d{2})$/.exec(String(timeStr || ''));
  if (!d || !t) return null;
  const [y, m, day, h, mi] = [+d[1], +d[2], +d[3], +t[1], +t[2]];
  const probe = new Date(Date.UTC(y, m - 1, day));
  if (y < 2020 || y > 2100 || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== day || h > 23 || mi > 59) return null;
  return zonedToUtc({ y, m, d: day, h, mi }, tz);
}
// The moments an agent's schedule will run in the next `days` days (clock schedules only).
export function nextRuns(s, { now = new Date(), tz, days = 7 }) {
  const out = [];
  if (!s) return out;
  const end = now.getTime() + days * 864e5;
  if (s.kind === 'once') { const at = new Date(s.at); if (at > now && at.getTime() <= end) out.push(at); return out; }
  if (s.kind !== 'daily' || !Array.isArray(s.days) || !/^\d{2}:\d{2}$/.test(s.time || '')) return out;
  const [h, mi] = s.time.split(':').map(Number);
  const today = zonedParts(now, tz);
  for (let i = 0; i <= days; i++) {
    const day = addDays({ y: today.y, m: today.m, d: today.d }, i);
    if (!s.days.includes(day.dow)) continue;
    const c = zonedToUtc({ y: day.y, m: day.m, d: day.d, h, mi }, tz);
    if (c > now && c.getTime() <= end) out.push(c);
  }
  return out;
}
