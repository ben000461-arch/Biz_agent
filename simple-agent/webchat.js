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
  const restHeaders = () => {
    const h = { apikey: secret };
    if (secret.startsWith('eyJ')) h.authorization = `Bearer ${secret}`;
    return h;
  };
  const prune = (map) => { if (map.size > 500) for (const [k, v] of map) { if (v.until < now()) map.delete(k); } if (map.size > 1000) map.clear(); };

  // -> { userId } | { error: 'unauthorized' | 'unavailable' }
  async function verify(token) {
    if (!enabled) return { error: 'unavailable' };
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return { error: 'unauthorized' };
    const h = crypto.createHash('sha256').update(token).digest('hex');
    const hit = tokens.get(h);
    if (hit && hit.until > now()) return { userId: hit.userId };
    let res;
    try {
      res = await withTimeout(`${base}/auth/v1/user`, { method: 'GET', headers: { apikey: secret, authorization: `Bearer ${token}` } });
    } catch { return { error: 'unavailable' }; }
    if (res.status === 401 || res.status === 403) return { error: 'unauthorized' };
    if (!res.ok) return { error: 'unavailable' };
    let u;
    try { u = await res.json(); } catch { return { error: 'unavailable' }; }
    if (!u || typeof u.id !== 'string' || !UUID_RE.test(u.id)) return { error: 'unauthorized' };
    tokens.set(h, { userId: u.id, until: now() + tokenTtlMs });
    prune(tokens);
    return { userId: u.id };
  }

  // -> { chatId } | { error: 'unlinked' | 'unavailable' }
  async function chatFor(userId) {
    if (!enabled) return { error: 'unavailable' };
    if (!UUID_RE.test(String(userId))) return { error: 'unlinked' };
    const hit = links.get(userId);
    if (hit && hit.until > now()) return { chatId: hit.chatId };
    let rows;
    try {
      const res = await withTimeout(`${base}/rest/v1/tenant_users?user_id=eq.${userId}&select=chat_id&limit=1`, { method: 'GET', headers: restHeaders() });
      if (!res.ok) return { error: 'unavailable' };
      rows = await res.json();
    } catch { return { error: 'unavailable' }; }
    const chatId = Array.isArray(rows) && rows[0] ? String(rows[0].chat_id ?? '') : '';
    if (!/^-?\d{1,20}$/.test(chatId)) return { error: 'unlinked' };
    links.set(userId, { chatId, until: now() + linkTtlMs });
    prune(links);
    return { chatId };
  }

  return { verify, chatFor, enabled };
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

export function mountWebChat(app, { express, auth, getTenant, run, siteOrigin, extraOrigins = [], perUserPerMinute = 40, perIpPerMinute = 120, log = () => {} }) {
  const allowed = new Set([siteOrigin, ...extraOrigins].filter(Boolean));
  const userLimit = createLimiter({ max: perUserPerMinute });
  const ipLimit = createLimiter({ max: perIpPerMinute });

  const cors = (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' });
    const origin = req.get('origin');
    if (origin && allowed.has(origin)) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type, ngrok-skip-browser-warning',
        'Access-Control-Max-Age': '600',
      });
    } else if (origin) {
      return res.status(403).json({ error: 'origin not allowed' }); // a page from somewhere else may not use this
    }
    next();
  };

  app.options('/web/chat', cors, (_req, res) => res.status(204).end());

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
      res.json(files.length ? { replies: out, files } : { replies: out });
    } catch (err) {
      console.error('[web chat] failed:', err?.name || 'Error');
      res.status(500).json({ error: 'something went wrong' });
    }
  });
}
