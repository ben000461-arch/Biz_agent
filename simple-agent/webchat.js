// The door the website's chat box knocks on: POST /web/chat.
//
// The dashboard sends the logged-in person's Supabase access token. We ask Supabase who that is, look up
// which agent (Telegram chat) is tied to them, and hand the text to the same engine Telegram uses. Replies
// come back as {replies:[...]} instead of going to Telegram.
//
// What this file never does: log what anyone wrote, log a token, or trust the browser. The token is only
// ever sent to Supabase; the person is whoever Supabase says they are.
import crypto from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{4,2048}\.[A-Za-z0-9_-]{4,2048}\.[A-Za-z0-9_-]{4,2048}$/;
export const MAX_WEB_MESSAGE = 2000;

export function createWebAuth({ url, key, fetchImpl = globalThis.fetch, timeoutMs = 8000, now = () => Date.now(), tokenTtlMs = 60000, linkTtlMs = 30000 } = {}) {
  const base = String(url || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  const secret = String(key || '').trim();
  const enabled = Boolean(base && secret);
  const tokens = new Map(); // sha256(token) -> { userId, until }   (the token itself is never kept)
  const links = new Map();  // userId -> { chatId, until }

  const withTimeout = async (u, opts) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try { return await fetchImpl(u, { ...opts, signal: ctl.signal }); } finally { clearTimeout(timer); }
  };
  const restHeaders = (prefer) => {
    const h = { 'content-type': 'application/json', apikey: secret };
    if (secret.startsWith('eyJ')) h.authorization = `Bearer ${secret}`;
    if (prefer) h.Prefer = prefer;
    return h;
  };
  const prune = (map) => { if (map.size > 500) for (const [k, v] of map) { if (v.until < now()) map.delete(k); } if (map.size > 1000) map.clear(); };

  // -> { userId } | { error: 'unauthorized' | 'unavailable' }
  async function verify(token) {
    if (!enabled) return { error: 'unavailable' };
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return { error: 'unauthorized' };
    const h = crypto.createHash('sha256').update(token).digest('hex');
    const hit = tokens.get(h);
    if (hit && hit.until > now()) return { userId: hit.userId, email: hit.email, emailConfirmed: hit.emailConfirmed };
    let res;
    try {
      res = await withTimeout(`${base}/auth/v1/user`, { method: 'GET', headers: { apikey: secret, authorization: `Bearer ${token}` } });
    } catch { return { error: 'unavailable' }; }
    if (res.status === 401 || res.status === 403) return { error: 'unauthorized' };
    if (!res.ok) return { error: 'unavailable' };
    let u;
    try { u = await res.json(); } catch { return { error: 'unavailable' }; }
    if (!u || typeof u.id !== 'string' || !UUID_RE.test(u.id)) return { error: 'unauthorized' };
    // the email comes with it: an office invite is matched to the person by their (confirmed) email
    const email = typeof u.email === 'string' ? u.email.trim().toLowerCase().slice(0, 254) : '';
    const emailConfirmed = Boolean(u.email_confirmed_at || u.confirmed_at);
    tokens.set(h, { userId: u.id, email, emailConfirmed, until: now() + tokenTtlMs });
    prune(tokens);
    return { userId: u.id, email, emailConfirmed };
  }

  // -> { chatId } | { error: 'unlinked' | 'employee' | 'unavailable' }
  //
  // An office's EMPLOYEES are linked to the owner's business too (so the Agent extension works for them),
  // but that must not hand them the owner's agent: chat, calendar, connections, billing, account. So they
  // only get the business back when the caller says it's an Agent-extension door ({ agent: true });
  // everywhere else they look unlinked. If we can't tell who someone is, we say "unavailable" (fail closed).
  async function chatFor(userId, { agent = false } = {}) {
    if (!enabled) return { error: 'unavailable' };
    if (!UUID_RE.test(String(userId))) return { error: 'unlinked' };
    let hit = links.get(userId);
    if (!hit || hit.until <= now()) {
      let rows, roles;
      try {
        const [res, r2] = await Promise.all([
          withTimeout(`${base}/rest/v1/tenant_users?user_id=eq.${userId}&select=chat_id&limit=1`, { method: 'GET', headers: restHeaders() }),
          withTimeout(`${base}/rest/v1/office_members?user_id=eq.${userId}&status=eq.active&select=role,chat_id`, { method: 'GET', headers: restHeaders() }),
        ]);
        if (!res.ok) return { error: 'unavailable' };
        rows = await res.json();
        if (r2.ok) roles = await r2.json();
        else {
          // no office tables at all (a setup without Office) means nobody is an employee; any other failure: stop
          const body = await r2.text().catch(() => '');
          if (!(r2.status === 404 || /PGRST205|42P01|does not exist|Could not find the table/i.test(body))) return { error: 'unavailable' };
          roles = [];
        }
      } catch { return { error: 'unavailable' }; }
      const chatId = Array.isArray(rows) && rows[0] ? String(rows[0].chat_id ?? '') : '';
      if (!/^-?\d{1,20}$/.test(chatId)) return { error: 'unlinked' };
      // an employee of the office this login is linked to (an owner row for the same business wins)
      const mine = Array.isArray(roles) ? roles.filter((r) => String(r?.chat_id) === chatId) : [];
      const employee = mine.length > 0 && !mine.some((r) => r?.role === 'owner');
      hit = { chatId, employee, until: now() + linkTtlMs };
      links.set(userId, hit);
      prune(links);
    }
    if (hit.employee && !agent) return { error: 'employee' };
    return { chatId: hit.chatId, employee: hit.employee };
  }

  // Save user + assistant messages to Supabase (fire-and-forget, never blocks the response)
  async function saveMessages(chatId, userText, assistantReplies) {
    if (!enabled) return;
    const rows = [
      { chat_id: chatId, role: 'user', content: userText },
      ...assistantReplies.map((r) => ({ chat_id: chatId, role: 'assistant', content: r })),
    ];
    try {
      await withTimeout(`${base}/rest/v1/web_chat_messages`, {
        method: 'POST',
        headers: restHeaders('return=minimal'),
        body: JSON.stringify(rows),
      });
    } catch { /* best-effort: chat still works if save fails */ }
  }

  // Load recent messages for a chat (called by GET /web/chat/history)
  async function loadMessages(chatId, limit = 300) {
    if (!enabled) return [];
    try {
      const res = await withTimeout(
        `${base}/rest/v1/web_chat_messages?chat_id=eq.${encodeURIComponent(chatId)}&select=role,content,created_at&order=created_at.desc&limit=${limit}`,
        { method: 'GET', headers: restHeaders() },
      );
      if (!res.ok) return [];
      const rows = await res.json();
      return Array.isArray(rows) ? rows.reverse() : []; // the NEWEST `limit` messages, oldest first
    } catch { return []; }
  }

  // forget a cached link right away (e.g. someone was just removed from an office)
  const forgetLink = (userId) => links.delete(userId);
  return { verify, chatFor, forgetLink, saveMessages, loadMessages, enabled };
}

// A tiny sliding-window counter: allow(key) -> true while under `max` hits in the last `windowMs`.
export function createLimiter({ max, windowMs = 60000, now = () => Date.now() }) {
  const hits = new Map();
  return (key) => {
    const t = now();
    const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (list.length >= max) { hits.set(key, list); return false; }
    list.push(t);
    hits.set(key, list);
    if (hits.size > 5000) for (const [k, v] of hits) { if (!v.length || t - v[v.length - 1] >= windowMs) hits.delete(k); }
    return true;
  };
}

export function mountWebChat(app, { express, auth, getTenant, run, siteOrigin, extraOrigins = [], perUserPerMinute = 40, perIpPerMinute = 120, log = () => {}, onError = () => {} }) {
  const allowed = new Set([siteOrigin, ...extraOrigins].filter(Boolean));
  const userLimit = createLimiter({ max: perUserPerMinute });
  const ipLimit = createLimiter({ max: perIpPerMinute });

  const cors = (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' });
    const origin = req.get('origin');
    if (origin && allowed.has(origin)) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type, ngrok-skip-browser-warning',
        'Access-Control-Max-Age': '600',
      });
    } else if (origin) {
      return res.status(403).json({ error: 'origin not allowed' });
    }
    next();
  };

  app.options('/web/chat', cors, (_req, res) => res.status(204).end());
  app.options('/web/chat/history', cors, (_req, res) => res.status(204).end());

  // ---- load chat history ----
  app.get('/web/chat/history', cors, async (req, res) => {
    try {
      const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
      const who = await auth.verify(m ? m[1] : '');
      if (who.error === 'unauthorized') return res.status(401).json({ error: 'sign in again' });
      if (who.error) return res.status(503).json({ error: 'try again in a moment' });

      const link = await auth.chatFor(who.userId);
      if (link.error === 'unavailable') return res.status(503).json({ error: 'try again in a moment' });
      if (!link.chatId) return res.json({ messages: [] });

      const messages = await auth.loadMessages(link.chatId);
      res.json({ messages });
    } catch (err) {
      console.error('[web chat history] failed:', err?.name || 'Error');
      res.status(500).json({ error: 'something went wrong' });
    }
  });

  // ---- send message ----
  app.post('/web/chat', cors, (req, res, next) => {
    if (!ipLimit(req.ip || 'x')) return res.status(429).json({ error: 'too many requests' });
    next();
  }, express.json({ limit: '8kb' }), async (req, res) => {
    try {
      const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
      const who = await auth.verify(m ? m[1] : '');
      if (who.error === 'unauthorized') return res.status(401).json({ error: 'sign in again' });
      if (who.error) return res.status(503).json({ error: 'try again in a moment' });

      const text = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
      if (!text) return res.status(400).json({ error: 'empty message' });
      if (text.length > MAX_WEB_MESSAGE) return res.status(400).json({ error: 'message too long' });

      if (!userLimit(who.userId)) return res.json({ replies: ['You’re sending messages faster than I can keep up. Give it a few seconds and try again.'] });

      const link = await auth.chatFor(who.userId);
      if (link.error === 'unavailable') return res.status(503).json({ error: 'try again in a moment' });
      const tenant = link.chatId ? getTenant(link.chatId) : null;
      if (!tenant) return res.json({ replies: ['Your account isn’t linked to an agent yet. Open the Get started tab and follow the steps, then come back.'] });

      const result = await run(tenant, text); // { replies, files } (an array is also accepted)
      const replies = Array.isArray(result) ? result : result.replies || [];
      const files = (Array.isArray(result) ? [] : result.files || []).slice(0, 3);
      const out = replies.map((r) => String(r).trim()).filter(Boolean).slice(0, 10);
      if (!out.length && !files.length) out.push('I’m getting messages faster than I can answer. Wait a few seconds and try again.');
      log(`[web chat ${tenant.chatId}] answered (${out.length} repl${out.length === 1 ? 'y' : 'ies'})`);

      // Save both sides of the conversation (fire-and-forget)
      auth.saveMessages(link.chatId, text, out).catch(() => {});

      res.json(files.length ? { replies: out, files } : { replies: out });
    } catch (err) {
      console.error('[web chat] failed:', err?.name || 'Error');
      try { onError('chat', err); } catch { /* ignore */ }
      res.status(500).json({ error: 'something went wrong' });
    }
  });
}