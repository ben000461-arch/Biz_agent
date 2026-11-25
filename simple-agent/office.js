// Office AI: the business, its people, and what Agent did for them (supabase/office.sql).
//
// The agent server is the only thing that writes these tables (with the service key). Every read here is
// scoped to ONE business, and to one person unless the reader is that business's owner, the same walls the
// database itself enforces for anyone reading directly.
//
// What's recorded for a task: the employee's request in their own words (SSNs and card numbers hidden), the
// site's name, and each step's name and whether it worked. Never the page's contents, never what was typed.
import { maskSensitive } from './agentpage.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_RE = /^-?\d{1,20}$/;
const tidy = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export function createOffice({ url, key, fetchImpl = globalThis.fetch, timeoutMs = 6000, now = () => Date.now(), cacheMs = 30000 } = {}) {
  const base = String(url || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  const secret = String(key || '').trim();
  const enabled = Boolean(base && secret);
  const headers = { 'content-type': 'application/json', apikey: secret };
  if (secret.startsWith('eyJ')) headers.authorization = `Bearer ${secret}`;

  async function rest(path, { method = 'GET', body, prefer } = {}) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}/rest/v1/${path}`, { method, headers: { ...headers, ...(prefer ? { Prefer: prefer } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
      if (!res.ok) return { ok: false, status: res.status };
      const text = await res.text();
      return { ok: true, rows: text ? JSON.parse(text) : [] };
    } catch { return { ok: false, status: 0 }; } finally { clearTimeout(t); }
  }

  // ---- who is this person, in which business? (active members only; cached briefly)
  const people = new Map();
  async function member(userId) {
    if (!enabled) return { error: 'unavailable' };
    if (!UUID_RE.test(String(userId))) return { error: 'not_member' };
    const hit = people.get(userId);
    if (hit && hit.until > now()) return hit.value;
    const r = await rest(`office_members?user_id=eq.${userId}&status=eq.active&select=chat_id,email,name,role&limit=1`);
    if (!r.ok) return { error: 'unavailable' };
    const m = r.rows[0];
    const value = m && CHAT_RE.test(String(m.chat_id)) ? { chatId: String(m.chat_id), email: String(m.email || ''), name: m.name ? String(m.name) : '', role: m.role === 'owner' ? 'owner' : 'employee' } : { error: 'not_member' };
    people.set(userId, { value, until: now() + cacheMs });
    if (people.size > 2000) people.delete(people.keys().next().value);
    return value;
  }
  const forget = (userId) => people.delete(userId); // e.g. right after someone is removed

  async function business(chatId) {
    if (!enabled || !CHAT_RE.test(String(chatId))) return null;
    const r = await rest(`office_businesses?chat_id=eq.${chatId}&select=name,accent&limit=1`);
    if (!r.ok || !r.rows[0]) return null;
    const accent = /^#[0-9a-f]{6}$/i.test(r.rows[0].accent || '') ? r.rows[0].accent : null;
    return { name: tidy(r.rows[0].name, 80), accent };
  }

  // ---- record a task (best effort: never throws into the caller)
  function cleanSteps(steps) {
    return (Array.isArray(steps) ? steps : []).slice(0, 25).map((s) => ({ what: maskSensitive(tidy(s?.what, 140)), ok: s?.ok === true })).filter((s) => s.what);
  }
  async function logTask(m, task) {
    if (!enabled || !m?.chatId) return { ok: false };
    let site = '';
    try { site = new URL(String(task.url || '')).hostname.replace(/^www\./, ''); } catch { site = ''; }
    const outcome = ['done', 'partial', 'failed', 'cancelled'].includes(task.outcome) ? task.outcome : null;
    if (!outcome) return { ok: false };
    const approval = task.outcome === 'cancelled' && task.denied ? 'denied' : task.auto ? 'auto' : 'approved';
    const n = (x) => Math.max(0, Math.min(99, Number.parseInt(x, 10) || 0));
    const row = {
      chat_id: m.chatId, user_id: m.userId || null, email: m.email || null,
      request: maskSensitive(tidy(task.request, 500)) || null, site: tidy(site, 120) || null,
      outcome, approval, steps: cleanSteps(task.steps), done: n(task.done), total: n(task.total),
    };
    const r = await rest('office_activity', { method: 'POST', body: row, prefer: 'return=minimal' });
    return { ok: r.ok };
  }

  // ---- read: one business; one person unless an owner is asking
  async function activity(m, { person = '', before = '', limit = 30, days = 0 } = {}) {
    if (!enabled || !m?.chatId) return { error: 'unavailable' };
    const q = [`chat_id=eq.${m.chatId}`, 'select=id,ts,email,request,site,outcome,approval,steps,done,total', 'order=id.desc', `limit=${Math.max(1, Math.min(100, Number(limit) || 30))}`];
    if (m.role !== 'owner') q.push(`user_id=eq.${m.userId}`);
    else if (person && UUID_RE.test(person)) q.push(`user_id=eq.${person}`);
    if (/^\d{1,18}$/.test(String(before))) q.push(`id=lt.${before}`);
    if (days > 0) q.push(`ts=gte.${new Date(now() - days * 864e5).toISOString()}`);
    const r = await rest(`office_activity?${q.join('&')}`);
    return r.ok ? { rows: r.rows } : { error: 'unavailable' };
  }

  // the numbers across the top of the dashboard: last 7 days
  async function summary(m, { person = '' } = {}) {
    const a = await activity(m, { person, limit: 100, days: 7 });
    if (a.error) return a;
    const rows = a.rows;
    const count = (f) => rows.filter(f).length;
    // per day (this computer's time zone, oldest first) for the chart, and who / where for the side cards
    const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const days = [];
    for (let i = 6; i >= 0; i--) days.push({ date: dayKey(now() - i * 864e5), done: 0, problems: 0, denied: 0 });
    const byDate = new Map(days.map((d) => [d.date, d]));
    const people = new Map(), sites = new Map();
    for (const r of rows) {
      const d = byDate.get(dayKey(r.ts));
      if (d) { if (r.outcome === 'done') d.done++; else if (r.outcome === 'cancelled') d.denied++; else d.problems++; }
      const e = String(r.email || '').toLowerCase();
      if (e) { const p = people.get(e) || { email: e, tasks: 0, done: 0 }; p.tasks++; if (r.outcome === 'done') p.done++; people.set(e, p); }
      if (r.site) sites.set(r.site, (sites.get(r.site) || 0) + 1);
    }
    return {
      days,
      today: days[6].done + days[6].problems + days[6].denied,
      partial: count((r) => r.outcome === 'partial'),
      people: m.role === 'owner' ? [...people.values()].sort((a, b) => b.tasks - a.tasks).slice(0, 6) : [],
      sites: [...sites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([site, tasks]) => ({ site, tasks })),
      tasks: rows.length,
      done: count((r) => r.outcome === 'done'),
      problems: count((r) => r.outcome === 'failed' || r.outcome === 'partial'),
      approved: count((r) => r.approval === 'approved'),
      auto: count((r) => r.approval === 'auto'),
      denied: count((r) => r.approval === 'denied'),
      capped: rows.length >= 100, // "100+"
    };
  }

  async function team(m) {
    if (!enabled || !m?.chatId) return { error: 'unavailable' };
    if (m.role !== 'owner') return { people: [] };
    const r = await rest(`office_members?chat_id=eq.${m.chatId}&status=neq.removed&select=id,user_id,email,name,role,status,invited_at,joined_at&order=role.desc,email.asc`);
    return r.ok ? { people: r.rows.map((p) => ({ id: p.user_id || null, memberId: p.id, email: String(p.email), name: p.name || '', role: p.role, status: p.status, invitedAt: p.invited_at, joinedAt: p.joined_at })) } : { error: 'unavailable' };
  }

  // ---- Team: the owner adds people by email. Each email belongs to ONE office. The person gets an email from
  //      the sign-in service, follows it and sets their OWN password (the owner never sees or sets it).
  const EMAIL_RE = /^[^\s@<>()"',;]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
  const cleanEmail = (e) => String(e ?? '').trim().toLowerCase();
  async function byEmail(email) {
    const r = await rest(`office_members?email=eq.${encodeURIComponent(email)}&select=id,chat_id,user_id,role,status&limit=1`);
    return r.ok ? { row: r.rows[0] || null } : { error: 'unavailable' };
  }
  // ask the sign-in service to email them a "join your office" link
  async function sendInvite(email, { redirectTo, office: officeName } = {}) {
    const q = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : '';
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}/auth/v1/invite${q}`, { method: 'POST', headers, body: JSON.stringify({ email, data: { office: officeName || '' } }), signal: ctl.signal });
      if (res.ok) return { sent: true };
      let body = ''; try { body = await res.text(); } catch { /* ignore */ }
      // They already have a login, maybe one that never got a password (an earlier invite link that was opened
      // somewhere else, or ran out). Send them a "set your password" link instead, so they can always get in.
      if (res.status === 422 || /already been registered|already registered|email_exists/i.test(body)) return setPasswordLink(email, redirectTo);
      // say WHY in the bot log (Supabase's own error code and message; any email address in it is blanked out)
      let why = ''; try { const j = JSON.parse(body); why = `${j.error_code || j.code || ''} ${j.msg || j.message || j.error_description || ''}`; } catch { why = body; }
      console.warn(`[office] invite email not sent: HTTP ${res.status} ${String(why).replace(/[^\s@"']+@[^\s@"']+/g, '<email>').slice(0, 200)}`);
      if (res.status === 429 || /rate limit/i.test(body)) return { sent: false, emailError: 'rate_limited' };
      return { sent: false, emailError: 'email_failed' };
    } catch (e) { console.warn(`[office] invite email not sent: ${e?.name === 'AbortError' ? 'timed out' : 'could not reach Supabase'}`); return { sent: false, emailError: 'email_failed' }; } finally { clearTimeout(t); }
  }

  async function setPasswordLink(email, redirectTo) {
    const q = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : '';
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}/auth/v1/recover${q}`, { method: 'POST', headers, body: JSON.stringify({ email }), signal: ctl.signal });
      if (res.ok) return { sent: true, existing: true };
      let body = ''; try { body = await res.text(); } catch { /* ignore */ }
      console.warn(`[office] set-password email not sent: HTTP ${res.status} ${String(body).replace(/[^\s@"']+@[^\s@"']+/g, '<email>').slice(0, 200)}`);
      return { sent: false, existing: true, emailError: res.status === 429 || /rate limit|seconds/i.test(body) ? 'rate_limited' : 'email_failed' };
    } catch { return { sent: false, existing: true, emailError: 'email_failed' }; } finally { clearTimeout(t); }
  }

  async function invite(m, { email, name } = {}, opts = {}) {
    if (!enabled || !m?.chatId) return { error: 'unavailable' };
    if (m.role !== 'owner') return { error: 'owner_only' };
    const e = cleanEmail(email);
    if (!EMAIL_RE.test(e) || e.length > 254) return { error: 'bad_email' };
    const nm = tidy(name, 80) || null;
    const found = await byEmail(e);
    if (found.error) return found;
    const row = found.row;
    if (row && String(row.chat_id) !== m.chatId) return { error: 'taken' }; // one email, one office
    if (row && row.status === 'active') return { error: 'already_member' };
    let r;
    if (row) r = await rest(`office_members?id=eq.${row.id}`, { method: 'PATCH', body: { status: 'invited', role: 'employee', ...(nm ? { name: nm } : {}), invited_at: new Date(now()).toISOString(), joined_at: null, user_id: null }, prefer: 'return=minimal' });
    else r = await rest('office_members', { method: 'POST', body: { chat_id: m.chatId, email: e, name: nm, role: 'employee', status: 'invited' }, prefer: 'return=minimal' });
    if (!r.ok) return { error: r.status === 409 ? 'taken' : 'unavailable' };
    const sent = await sendInvite(e, opts);
    return { ok: true, email: e, ...sent };
  }

  async function resend(m, memberId, opts = {}) {
    if (!enabled || !m?.chatId) return { error: 'unavailable' };
    if (m.role !== 'owner') return { error: 'owner_only' };
    if (!/^\d{1,18}$/.test(String(memberId))) return { error: 'not_found' };
    const r = await rest(`office_members?id=eq.${memberId}&chat_id=eq.${m.chatId}&status=eq.invited&select=email&limit=1`);
    if (!r.ok) return { error: 'unavailable' };
    if (!r.rows[0]) return { error: 'not_found' };
    await rest(`office_members?id=eq.${memberId}&chat_id=eq.${m.chatId}`, { method: 'PATCH', body: { invited_at: new Date(now()).toISOString() }, prefer: 'return=minimal' });
    return { ok: true, email: r.rows[0].email, ...(await sendInvite(String(r.rows[0].email), opts)) };
  }

  // Removing someone cuts them off at once: the dashboard, and the Agent extension (its link to the office).
  async function remove(m, memberId) {
    if (!enabled || !m?.chatId) return { error: 'unavailable' };
    if (m.role !== 'owner') return { error: 'owner_only' };
    if (!/^\d{1,18}$/.test(String(memberId))) return { error: 'not_found' };
    const r = await rest(`office_members?id=eq.${memberId}&chat_id=eq.${m.chatId}&select=id,user_id,role,status&limit=1`);
    if (!r.ok) return { error: 'unavailable' };
    const row = r.rows[0];
    if (!row || row.status === 'removed') return { error: 'not_found' };
    if (row.role === 'owner') return { error: 'cant_remove_owner' };
    const up = await rest(`office_members?id=eq.${memberId}&chat_id=eq.${m.chatId}`, { method: 'PATCH', body: { status: 'removed' }, prefer: 'return=minimal' });
    if (!up.ok) return { error: 'unavailable' };
    if (row.user_id) {
      await rest(`tenant_users?user_id=eq.${row.user_id}&chat_id=eq.${m.chatId}`, { method: 'DELETE', prefer: 'return=minimal' });
      forget(row.user_id);
    }
    return { ok: true, userId: row.user_id || null };
  }

  // First sign-in after an invite: match the login to the invite by its CONFIRMED email, mark them active, and
  // link the login to the office so the Agent extension works for them too.
  async function claim(userId, email, emailConfirmed) {
    if (!enabled || !UUID_RE.test(String(userId))) return { ok: false };
    const e = cleanEmail(email);
    if (!emailConfirmed || !EMAIL_RE.test(e)) return { ok: false };
    const found = await byEmail(e);
    const row = found.row;
    if (!row || row.status === 'removed' || (row.user_id && row.user_id !== userId)) return { ok: false };
    if (!CHAT_RE.test(String(row.chat_id))) return { ok: false };
    if (!row.user_id || row.status !== 'active') {
      const up = await rest(`office_members?id=eq.${row.id}&status=neq.removed`, { method: 'PATCH', body: { user_id: userId, status: 'active', joined_at: new Date(now()).toISOString() }, prefer: 'return=minimal' });
      if (!up.ok) return { ok: false };
    }
    // the extension's link (never overwrites a link this login already has)
    await rest('tenant_users', { method: 'POST', body: { user_id: userId, chat_id: String(row.chat_id) }, prefer: 'return=minimal,resolution=ignore-duplicates' });
    forget(userId);
    return { ok: true, chatId: String(row.chat_id) };
  }

  // ---- Account: a person changes the name shown for them (their own row only)
  async function rename(m, name) {
    if (!enabled || !m?.chatId || !UUID_RE.test(String(m.userId))) return { error: 'unavailable' };
    const nm = tidy(name, 80);
    if (!nm) return { error: 'bad_name' };
    const r = await rest(`office_members?user_id=eq.${m.userId}&chat_id=eq.${m.chatId}&status=eq.active`, { method: 'PATCH', body: { name: nm }, prefer: 'return=minimal' });
    if (!r.ok) return { error: 'unavailable' };
    forget(m.userId);
    return { ok: true, name: nm };
  }

  return { enabled, member, forget, business, logTask, activity, summary, team, invite, resend, remove, claim, rename };
}
