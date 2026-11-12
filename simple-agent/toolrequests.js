// "Add a tool" requests: a signed-in customer asks for an app the agent doesn't have yet, and the owner approves it in Telegram.
//
//   GET  /web/toolreq/list     -> { requests: [...] }          (this customer's own requests, newest first)
//   POST /web/toolreq/new      {name, url?, purpose, access, scope?, how?}  -> { ok, id }
//   POST /web/toolreq/cancel   {id}                            -> { ok }
//   adminCommand(text, fromId) -> reply text, or null when the message is not one of ours   (owner only)
//       /tool_requests            lists what is waiting
//       /tool_approve_<id> [note] approves it, tells the customer
//       /tool_deny_<id> [reason]  declines it, tells the customer
//       /tool_ready_<id>          marks it set up, tells the customer
//
// Rules this file keeps:
//   * A request is only a note. It never connects anything and never gives the agent any access.
//   * No passwords, keys or tokens are collected here. The form says so, and the length limits keep long secrets out.
//   * Whatever the customer typed is shown to the owner with "/" swapped for a look-alike, so nothing they write can become a tappable command.
//   * Only the owner's Telegram id can approve, deny or mark ready.
//   * Not configured? Every route answers 501 {error:'toolreq_off'} and the dashboard says requests are not available yet.
import express from 'express';

export const ACCESS = ['read', 'write'];
export const HOW = ['signin', 'key', 'unsure'];
export const STATUSES = ['pending', 'approved', 'ready', 'denied', 'cancelled'];
const MAX_PENDING = 3;
const MAX_PER_DAY = 10;

// ---- helpers (exported so they can be tested) --------------------------------------------------------
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]', 'g');
export const clean = (v, max) => String(v ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
// Telegram turns "/word" into a tappable command. The division slash looks the same but does nothing.
export const inert = (s) => String(s ?? '').replace(/[/\\]/g, '∕');

export function cleanUrl(v) {
  const raw = clean(v, 200);
  if (!raw) return { ok: true, url: null };
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`); } catch { return { ok: false }; }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password) return { ok: false };
  if (!host.includes('.') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) return { ok: false };
  if (/(^|\.)(localhost|local|internal|lan|home|corp)$/.test(host)) return { ok: false };
  return { ok: true, url: `https://${host}` }; // the website only, never a path or query
}

export function validate(body) {
  const name = clean(body?.name, 60);
  if (name.length < 2 || !/[a-z0-9]/i.test(name)) return { error: 'Tell us the tool’s name.' };
  const purpose = clean(body?.purpose, 500);
  if (purpose.length < 8) return { error: 'Say in a sentence what you want your agent to do with it.' };
  const access = ACCESS.includes(body?.access) ? body.access : 'read';
  const how = HOW.includes(body?.how) ? body.how : 'unsure';
  const u = cleanUrl(body?.url);
  if (!u.ok) return { error: 'The website should be a normal https address, like slack.com.' };
  return { value: { tool_name: name, tool_url: u.url, purpose, access, scope_note: clean(body?.scope, 200) || null, connect_how: how } };
}

const HOW_TEXT = { signin: 'will sign in with their own account', key: 'has an API key or admin access', unsure: 'is not sure yet' };
const ACCESS_TEXT = { read: 'read only', write: 'read and write, asking before each change' };

export function alertText(row, who) {
  return [
    `🧩 New tool request #${row.id}`,
    `Tool: ${inert(row.tool_name)}${row.tool_url ? ` (${inert(row.tool_url.replace(/^https:\/\//, ''))})` : ''}`,
    `From: ${inert(who || 'a customer')} (chat ${row.chat_id})`,
    `Access: ${ACCESS_TEXT[row.access] || row.access}`,
    `Wants to: ${inert(row.purpose)}`,
    ...(row.scope_note ? [`Only: ${inert(row.scope_note)}`] : []),
    `Connect: ${HOW_TEXT[row.connect_how] || 'not sure yet'}`,
    '',
    `Approve: /tool_approve_${row.id}`,
    `Deny: /tool_deny_${row.id}   (add a reason after it if you like)`,
  ].join('\n');
}

// ---- the module --------------------------------------------------------------------------------------
export function mountToolRequests(app, {
  auth, supabaseUrl, supabaseKey, adminId,
  notifyAdmin = null, notifyUser = null, describeChat = null,
  env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(),
  origins = [...String(env.WEB_ORIGINS || '').split(','), env.SITE_URL || ''].map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
  log = () => {},
} = {}) {
  const sbBase = String(supabaseUrl || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  const sbKey = String(supabaseKey || '').trim();
  const admin = String(adminId || '').trim();
  const enabled = Boolean(sbBase && sbKey && auth);

  const timed = async (url, opts, ms = 8000) => {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), ms);
    try { return await fetchImpl(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(timer); }
  };
  const headers = (prefer) => ({ 'content-type': 'application/json', apikey: sbKey, ...(sbKey.startsWith('eyJ') ? { authorization: `Bearer ${sbKey}` } : {}), ...(prefer ? { Prefer: prefer } : {}) });
  const sb = (path, opts) => timed(`${sbBase}/rest/v1/${path}`, opts);
  const eq = (v) => encodeURIComponent(String(v));
  async function rows(path, opts) {
    const res = await sb(path, opts);
    if (!res.ok) throw new Error(`database ${res.status}`);
    const out = await res.json(); return Array.isArray(out) ? out : [];
  }
  const tell = (fn, ...args) => { if (typeof fn !== 'function') return; Promise.resolve().then(() => fn(...args)).catch((e) => log(`[toolreq] message not sent: ${e?.message || 'Error'}`)); };

  // -- web routes (same login check as /web/chat)
  const cors = (req, res, next) => {
    const origin = req.get('origin');
    if (origin && origins.includes(origin)) {
      res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type, ngrok-skip-browser-warning', 'Access-Control-Max-Age': '600', Vary: 'Origin' });
    } else if (origin) return res.status(403).json({ error: 'origin not allowed' });
    next();
  };
  const hits = new Map();
  const limited = (key, max = 20, windowMs = 60000) => {
    const t = now(); const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    arr.push(t); hits.set(key, arr); if (hits.size > 2000) hits.clear();
    return arr.length > max;
  };
  async function who(req, res) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
    const v = await auth.verify(m ? m[1] : '');
    if (v.error === 'unauthorized') { res.status(401).json({ error: 'sign in again' }); return null; }
    if (v.error) { res.status(503).json({ error: 'try again in a moment' }); return null; }
    if (limited(`u:${v.userId}`)) { res.status(429).json({ error: 'too many requests' }); return null; }
    const link = await auth.chatFor(v.userId);
    if (link.error === 'unavailable') { res.status(503).json({ error: 'try again in a moment' }); return null; }
    if (!link.chatId) { res.status(409).json({ error: 'not_linked', message: 'Link this login to your agent first (see Get started).' }); return null; }
    return { chatId: String(link.chatId) };
  }
  const off = (res) => res.status(501).json({ error: 'toolreq_off' });
  const gate = (req, res, next) => (limited(`ip:${req.ip || 'x'}`, 90) ? res.status(429).json({ error: 'too many requests' }) : next());

  app.options(['/web/toolreq/list', '/web/toolreq/new', '/web/toolreq/cancel'], cors, (_req, res) => res.status(204).end());

  app.get('/web/toolreq/list', cors, gate, async (req, res) => {
    if (!enabled) return off(res);
    try {
      const me = await who(req, res); if (!me) return;
      const list = await rows(`tool_requests?chat_id=eq.${eq(me.chatId)}&select=id,tool_name,tool_url,access,status,decision_note,created_at,decided_at&order=id.desc&limit=20`, { method: 'GET', headers: headers() });
      res.json({ requests: list });
    } catch (err) {
      console.error('[toolreq] list failed:', err?.message || 'Error');
      res.status(500).json({ error: 'something went wrong' });
    }
  });

  app.post('/web/toolreq/new', cors, gate, express.json({ limit: '8kb' }), async (req, res) => {
    if (!enabled) return off(res);
    try {
      const me = await who(req, res); if (!me) return;
      const v = validate(req.body);
      if (v.error) return res.status(400).json({ error: 'invalid', message: v.error });
      const mine = await rows(`tool_requests?chat_id=eq.${eq(me.chatId)}&created_at=gte.${eq(new Date(now() - 864e5).toISOString())}&select=id,tool_name,status&limit=100`, { method: 'GET', headers: headers() });
      const pending = mine.filter((r) => r.status === 'pending');
      if (pending.some((r) => String(r.tool_name).toLowerCase() === v.value.tool_name.toLowerCase())) return res.status(409).json({ error: 'duplicate', message: `You already asked for ${v.value.tool_name}. It is waiting for a decision.` });
      if (pending.length >= MAX_PENDING) return res.status(429).json({ error: 'too_many_pending', message: `You have ${MAX_PENDING} requests waiting. We will get to those first.` });
      if (mine.length >= MAX_PER_DAY) return res.status(429).json({ error: 'too_many_today', message: 'That is a lot of requests for one day. Try again tomorrow.' });
      const made = await rows('tool_requests', { method: 'POST', headers: headers('return=representation'), body: JSON.stringify({ chat_id: me.chatId, ...v.value }) });
      const row = made[0];
      if (!row?.id) throw new Error('request not saved');
      log(`[toolreq] #${row.id} ${v.value.tool_name} requested by chat ${me.chatId}`);
      tell(notifyAdmin, alertText(row, typeof describeChat === 'function' ? describeChat(me.chatId) : null));
      res.json({ ok: true, id: row.id });
    } catch (err) {
      console.error('[toolreq] new failed:', err?.message || 'Error');
      res.status(500).json({ error: 'something went wrong' });
    }
  });

  app.post('/web/toolreq/cancel', cors, gate, express.json({ limit: '2kb' }), async (req, res) => {
    if (!enabled) return off(res);
    try {
      const me = await who(req, res); if (!me) return;
      const id = Number(req.body?.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'invalid' });
      const out = await rows(`tool_requests?id=eq.${id}&chat_id=eq.${eq(me.chatId)}&status=eq.pending`, { method: 'PATCH', headers: headers('return=representation'), body: JSON.stringify({ status: 'cancelled', decided_at: new Date(now()).toISOString() }) });
      if (!out.length) return res.status(409).json({ error: 'not_pending', message: 'That request has already been decided.' });
      res.json({ ok: true });
    } catch (err) {
      console.error('[toolreq] cancel failed:', err?.message || 'Error');
      res.status(500).json({ error: 'something went wrong' });
    }
  });

  // -- owner commands (call this from the Telegram message handler, before anything else, with the sender's id)
  const CMD = /^\/tool_(approve|deny|ready)_(\d{1,9})(?:@\w+)?(?:\s+([\s\S]{0,300}))?$/i;
  const customerText = {
    approved: (r, note) => `✅ Your request for ${r.tool_name} was approved. We will set it up and message you here when it is ready.${note ? ` Note: ${note}` : ''}`,
    ready: (r) => `🔌 ${r.tool_name} is set up and ready. Your agent can use it now, and it asks before any change.`,
    denied: (r, note) => `Your request for ${r.tool_name} was not approved this time.${note ? ` Reason: ${note}` : ''}`,
  };
  async function adminCommand(text, fromId) {
    if (!enabled || !admin || String(fromId) !== admin) return null;
    const t = String(text || '').trim();
    if (/^\/tool_requests(@\w+)?$/i.test(t)) {
      const list = await rows('tool_requests?status=in.(pending,approved)&select=id,chat_id,tool_name,tool_url,access,purpose,scope_note,connect_how,status&order=id.asc&limit=10', { method: 'GET', headers: headers() });
      if (!list.length) return 'No tool requests are waiting.';
      return list.map((r) => `${alertText(r, typeof describeChat === 'function' ? describeChat(r.chat_id) : null)}${r.status === 'approved' ? `\nStatus: approved, not set up yet. Mark it done: /tool_ready_${r.id}` : ''}`).join('\n\n———\n\n');
    }
    const m = CMD.exec(t);
    if (!m) return null;
    const action = m[1].toLowerCase(); const id = Number(m[2]); const note = clean(m[3], 300);
    const from = action === 'ready' ? 'approved' : 'pending';
    const to = action === 'approve' ? 'approved' : action === 'deny' ? 'denied' : 'ready';
    const out = await rows(`tool_requests?id=eq.${id}&status=eq.${from}`, { method: 'PATCH', headers: headers('return=representation'), body: JSON.stringify({ status: to, decision_note: note || null, decided_at: new Date(now()).toISOString() }) });
    if (!out.length) return `Request #${id} is not ${from}, so nothing changed.`;
    const r = out[0];
    tell(notifyUser, r.chat_id, customerText[to](r, note));
    log(`[toolreq] #${id} -> ${to}`);
    return `${to === 'denied' ? 'Declined' : to === 'ready' ? 'Marked ready' : 'Approved'} #${id}: ${inert(r.tool_name)}. The customer was told.${to === 'approved' ? ` When it is set up, send /tool_ready_${id}.` : ''}`;
  }

  log(`Tool requests: ${enabled ? 'on' : 'OFF (no database settings)'}${enabled && !admin ? ', owner id missing' : ''}.`);
  return { enabled, adminCommand };
}
