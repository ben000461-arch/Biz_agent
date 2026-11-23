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
    return {
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
    const r = await rest(`office_members?chat_id=eq.${m.chatId}&status=neq.removed&select=user_id,email,name,role,status&order=role.desc,email.asc`);
    return r.ok ? { people: r.rows.map((p) => ({ id: p.user_id || null, email: String(p.email), name: p.name || '', role: p.role, status: p.status })) } : { error: 'unavailable' };
  }

  return { enabled, member, forget, business, logTask, activity, summary, team };
}
