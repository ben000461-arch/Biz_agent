// Connect an approved tool: the customer signs in on the tool's own page, we keep the access token encrypted, and test it once.
//
//   GET  /web/toolconn/list        -> { tools: [{request_id, tool_name, slug, access, state, account_label, connected_at, tested_at, last_error}] }
//   POST /web/toolconn/start       {request_id} -> { url }        (send the browser there to sign in)
//   GET  /oauth/callback/:slug     the tool sends the browser back here (no login header, protected by a signed, one-time state)
//   POST /web/toolconn/test        {request_id} -> { ok, error? }
//   POST /web/toolconn/disconnect  {request_id} -> { ok }         (forgets the saved token on our side)
//
// States shown to the customer: setting_up (not ready yet), manual (we will set it up by hand), can_connect, connected, failed.
//
// Rules this file keeps:
//   * Only a request the owner marked ready can be connected, and only with the access the customer asked for (read by default).
//   * Tokens are encrypted at rest (AES-256-GCM, key from TOOLCONN_KEY) and are never returned by any route or written to a log.
//   * Every address we call comes from the catalog below, never from anything a customer typed.
//   * The sign-in "state" is signed, expires in 10 minutes and works once, so a link cannot be replayed or aimed at another customer.
//   * Not configured (no key)? Every route answers 501 {error:'toolconn_off'}.
//   * Each provider needs one app registered by the owner: set <SLUG>_CLIENT_ID and <SLUG>_CLIENT_SECRET in .env (for example SLACK_CLIENT_ID).
import crypto from 'crypto';
import express from 'express';

// ---- the catalog: what we know about each tool -------------------------------------------------------
// Check each entry against the provider's current developer docs when you register the app.
export const CATALOG = {
  slack: {
    name: 'Slack', match: ['slack'],
    authorize: 'https://slack.com/oauth/v2/authorize', token: 'https://slack.com/api/oauth.v2.access',
    scopeParam: 'scope', scopeSep: ',', scopes: { read: ['channels:read', 'channels:history'], write: ['chat:write'] },
    tokenAuth: 'body',
    pick: (j) => (j && j.ok ? { token: j.access_token, label: j.team && j.team.name } : null),
    test: { url: 'https://slack.com/api/auth.test', method: 'POST', ok: (_s, j) => Boolean(j && j.ok) },
  },
  notion: {
    name: 'Notion', match: ['notion'],
    authorize: 'https://api.notion.com/v1/oauth/authorize', token: 'https://api.notion.com/v1/oauth/token',
    extraAuth: { owner: 'user' }, scopes: { read: [], write: [] }, tokenAuth: 'basic', tokenJson: true, tokenHeaders: { 'Notion-Version': '2026-03-11' },
    pick: (j) => (j && j.access_token ? { token: j.access_token, label: j.workspace_name } : null),
    test: { url: 'https://api.notion.com/v1/users/me', method: 'GET', headers: { 'Notion-Version': '2022-06-28' }, ok: (s) => s === 200 },
  },
};
export const slugFor = (toolName) => {
  const n = String(toolName || '').toLowerCase();
  return Object.keys(CATALOG).find((k) => CATALOG[k].match.some((m) => n.includes(m))) || null;
};

// ---- helpers (exported so they can be tested) --------------------------------------------------------
const b64 = (buf) => Buffer.from(buf).toString('base64url');
export function keyFrom(raw) {
  const s = String(raw || '').trim();
  return /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : null;
}
export function seal(key, text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', b64(iv), b64(c.getAuthTag()), b64(ct)].join('.');
}
export function open(key, sealed) {
  try {
    const [v, iv, tag, ct] = String(sealed).split('.');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch { return null; }
}
export function signState(key, data) {
  const body = b64(JSON.stringify(data));
  return `${body}.${b64(crypto.createHmac('sha256', key).update(body).digest())}`;
}
export function readState(key, state) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', key).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}
const short = (v, n = 160) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export function mountToolConn(app, {
  auth, supabaseUrl, supabaseKey, notifyAdmin = null, notifyUser = null,
  env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), catalog = CATALOG,
  origins = [...String(env.WEB_ORIGINS || '').split(','), env.SITE_URL || ''].map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
  log = () => {},
} = {}) {
  const sbBase = String(supabaseUrl || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  const sbKey = String(supabaseKey || '').trim();
  const key = keyFrom(env.TOOLCONN_KEY);
  const enabled = Boolean(sbBase && sbKey && auth && key);
  const apiBase = String(env.PUBLIC_API_URL || 'https://api.co-optech.com').replace(/\/+$/, '');
  const siteBase = String(env.SITE_URL || origins[0] || '').replace(/\/+$/, '');
  const returnTo = `${siteBase}/agent/dashboard.html#tools`;

  const timed = async (url, opts, ms = 10000) => {
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
  const tell = (fn, ...args) => { if (typeof fn !== 'function') return; Promise.resolve().then(() => fn(...args)).catch((e) => log(`[toolconn] message not sent: ${e?.message || 'Error'}`)); };
  const configured = (slug) => Boolean(catalog[slug] && env[`${slug.toUpperCase()}_CLIENT_ID`] && env[`${slug.toUpperCase()}_CLIENT_SECRET`]);

  // -- web routes (same login check as /web/toolreq)
  const cors = (req, res, next) => {
    const origin = req.get('origin');
    if (origin && origins.includes(origin)) {
      res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type, ngrok-skip-browser-warning', 'Access-Control-Max-Age': '600', Vary: 'Origin' });
    } else if (origin) return res.status(403).json({ error: 'origin not allowed' });
    next();
  };
  const hits = new Map();
  const limited = (k, max = 20, windowMs = 60000) => {
    const t = now(); const arr = (hits.get(k) || []).filter((x) => t - x < windowMs);
    arr.push(t); hits.set(k, arr); if (hits.size > 2000) hits.clear();
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
  const off = (res) => res.status(501).json({ error: 'toolconn_off' });
  const gate = (req, res, next) => (limited(`ip:${req.ip || 'x'}`, 90) ? res.status(429).json({ error: 'too many requests' }) : next());
  const fail = (res, err, what) => { console.error(`[toolconn] ${what} failed:`, err?.message || 'Error'); res.status(500).json({ error: 'something went wrong' }); };

  const myRequest = async (chatId, id) => {
    const n = Number(id); if (!Number.isInteger(n) || n < 1) return null;
    const [r] = await rows(`tool_requests?id=eq.${n}&chat_id=eq.${eq(chatId)}&select=id,tool_name,access,status&limit=1`, { method: 'GET', headers: headers() });
    return r || null;
  };

  // Run the one harmless check for a saved token. Returns { ok, error? }.
  async function runTest(slug, token) {
    const t = catalog[slug] && catalog[slug].test; if (!t) return { ok: true };
    try {
      const res = await timed(t.url, { method: t.method, headers: { authorization: `Bearer ${token}`, ...(t.headers || {}) } });
      let j = null; try { j = await res.json(); } catch { /* not json */ }
      return t.ok(res.status, j) ? { ok: true } : { ok: false, error: `The tool did not accept the connection${j && j.error ? ` (${short(j.error, 60)})` : ''}.` };
    } catch { return { ok: false, error: 'Could not reach the tool to check the connection.' }; }
  }

  app.options(['/web/toolconn/list', '/web/toolconn/start', '/web/toolconn/test', '/web/toolconn/disconnect'], cors, (_req, res) => res.status(204).end());

  app.get('/web/toolconn/list', cors, gate, async (req, res) => {
    if (!enabled) return off(res);
    try {
      const me = await who(req, res); if (!me) return;
      const reqs = await rows(`tool_requests?chat_id=eq.${eq(me.chatId)}&status=in.(approved,ready)&select=id,tool_name,access,status&order=id.desc&limit=20`, { method: 'GET', headers: headers() });
      const conns = reqs.length ? await rows(`tool_connections?chat_id=eq.${eq(me.chatId)}&select=request_id,status,account_label,connected_at,tested_at,last_error&limit=50`, { method: 'GET', headers: headers() }) : [];
      const byReq = new Map(conns.map((c) => [Number(c.request_id), c]));
      const tools = reqs.map((r) => {
        const slug = slugFor(r.tool_name); const c = byReq.get(Number(r.id));
        let state;
        if (c && c.status === 'connected') state = 'connected';
        else if (c && c.status === 'failed') state = 'failed';
        else if (r.status !== 'ready') state = 'setting_up';
        else if (!slug) state = 'manual';
        else state = configured(slug) ? 'can_connect' : 'setting_up';
        return { request_id: r.id, tool_name: r.tool_name, slug, access: r.access, state, account_label: c?.account_label || null, connected_at: c?.connected_at || null, tested_at: c?.tested_at || null, last_error: c?.last_error || null };
      });
      res.json({ tools });
    } catch (err) { fail(res, err, 'list'); }
  });

  const nonces = new Map(); // state nonces already used or issued; small and short lived
  app.post('/web/toolconn/start', cors, gate, express.json({ limit: '2kb' }), async (req, res) => {
    if (!enabled) return off(res);
    try {
      const me = await who(req, res); if (!me) return;
      const r = await myRequest(me.chatId, req.body && req.body.request_id);
      if (!r) return res.status(404).json({ error: 'not_found' });
      if (r.status !== 'ready') return res.status(409).json({ error: 'not_ready', message: 'This tool is not ready to connect yet.' });
      const slug = slugFor(r.tool_name);
      if (!slug) return res.status(409).json({ error: 'manual', message: 'We will set this one up for you by hand.' });
      if (!configured(slug)) return res.status(409).json({ error: 'provider_not_set_up', message: 'Setup for this tool is still in progress.' });
      const t = catalog[slug];
      const scopes = r.access === 'write' ? [...t.scopes.read, ...t.scopes.write] : [...t.scopes.read];
      const nonce = crypto.randomBytes(12).toString('hex');
      const t0 = now(); nonces.set(nonce, t0 + 600000);
      for (const [n, exp] of nonces) if (exp < t0) nonces.delete(n);
      const state = signState(key, { c: me.chatId, r: r.id, s: slug, e: t0 + 600000, n: nonce });
      const u = new URL(t.authorize);
      u.searchParams.set('client_id', env[`${slug.toUpperCase()}_CLIENT_ID`]);
      u.searchParams.set('redirect_uri', `${apiBase}/oauth/callback/${slug}`);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('state', state);
      if (scopes.length && t.scopeParam) u.searchParams.set(t.scopeParam, scopes.join(t.scopeSep || ' '));
      for (const [k, v] of Object.entries(t.extraAuth || {})) u.searchParams.set(k, v);
      res.json({ url: u.toString() });
    } catch (err) { fail(res, err, 'start'); }
  });

  app.get('/oauth/callback/:slug', async (req, res) => {
    const bad = (msg) => res.status(400).type('text/plain').send(msg);
    if (!enabled) return bad('Connections are not switched on.');
    const slug = String(req.params.slug || '');
    const st = readState(key, req.query.state);
    if (!st || st.s !== slug || !catalog[slug]) return bad('This sign-in link is not valid. Start again from the dashboard.');
    if (now() > st.e || !nonces.has(st.n)) return bad('This sign-in link has expired. Start again from the dashboard.');
    nonces.delete(st.n); // works once
    if (req.query.error || !req.query.code) return res.redirect(302, returnTo); // the customer said no, or the tool refused
    const t = catalog[slug];
    try {
      const id = env[`${slug.toUpperCase()}_CLIENT_ID`]; const secret = env[`${slug.toUpperCase()}_CLIENT_SECRET`];
      const redirect = `${apiBase}/oauth/callback/${slug}`;
      const hdr = { accept: 'application/json', ...(t.tokenHeaders || {}) };
      let body;
      if (t.tokenJson) { hdr['content-type'] = 'application/json'; body = JSON.stringify({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: redirect }); }
      else { hdr['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: redirect }).toString(); }
      if (t.tokenAuth === 'basic') hdr.authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
      else body = `${body}${t.tokenJson ? '' : `&client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}`}`;
      const tr = await timed(t.token, { method: 'POST', headers: hdr, body });
      let tj = null; try { tj = await tr.json(); } catch { /* not json */ }
      const got = t.pick(tj);
      const stamp = new Date(now()).toISOString();
      let row;
      if (!got || !got.token) row = { chat_id: st.c, request_id: st.r, slug, status: 'failed', token_enc: null, account_label: null, connected_at: null, tested_at: stamp, last_error: 'The tool did not finish the sign-in.' };
      else {
        const test = await runTest(slug, got.token);
        row = { chat_id: st.c, request_id: st.r, slug, status: test.ok ? 'connected' : 'failed', token_enc: seal(key, got.token), account_label: short(got.label, 80) || null, connected_at: stamp, tested_at: stamp, last_error: test.ok ? null : test.error };
      }
      const save = await sb('tool_connections?on_conflict=request_id', { method: 'POST', headers: headers('resolution=merge-duplicates,return=minimal'), body: JSON.stringify(row) });
      if (!save.ok) throw new Error(`database ${save.status}`);
      const ok = row.status === 'connected';
      tell(notifyAdmin, `${ok ? '🔌' : '⚠️'} ${t.name} ${ok ? 'connected' : 'connection failed'} (request #${st.r}, chat ${st.c})${ok ? '' : `: ${row.last_error}`}`);
      tell(notifyUser, st.c, ok ? `✅ ${t.name} is connected and checked.` : `⚠️ ${t.name} signed in, but the check failed. Open Tools in your dashboard to try again.`);
    } catch (err) { console.error('[toolconn] callback failed:', err?.message || 'Error'); }
    res.redirect(302, returnTo);
  });

  app.post('/web/toolconn/test', cors, gate, express.json({ limit: '2kb' }), async (req, res) => {
    if (!enabled) return off(res);
    try {
      const me = await who(req, res); if (!me) return;
      const r = await myRequest(me.chatId, req.body && req.body.request_id);
      if (!r) return res.status(404).json({ error: 'not_found' });
      const [c] = await rows(`tool_connections?request_id=eq.${Number(r.id)}&chat_id=eq.${eq(me.chatId)}&select=slug,token_enc&limit=1`, { method: 'GET', headers: headers() });
      const token = c && c.token_enc ? open(key, c.token_enc) : null;
      if (!token) return res.status(409).json({ error: 'not_connected', message: 'Connect it first.' });
      const test = await runTest(c.slug, token);
      const stamp = new Date(now()).toISOString();
      await sb(`tool_connections?request_id=eq.${Number(r.id)}&chat_id=eq.${eq(me.chatId)}`, { method: 'PATCH', headers: headers('return=minimal'), body: JSON.stringify({ status: test.ok ? 'connected' : 'failed', tested_at: stamp, last_error: test.ok ? null : test.error }) });
      res.json(test.ok ? { ok: true } : { ok: false, error: test.error });
    } catch (err) { fail(res, err, 'test'); }
  });

  app.post('/web/toolconn/disconnect', cors, gate, express.json({ limit: '2kb' }), async (req, res) => {
    if (!enabled) return off(res);
    try {
      const me = await who(req, res); if (!me) return;
      const r = await myRequest(me.chatId, req.body && req.body.request_id);
      if (!r) return res.status(404).json({ error: 'not_found' });
      const del = await sb(`tool_connections?request_id=eq.${Number(r.id)}&chat_id=eq.${eq(me.chatId)}`, { method: 'DELETE', headers: headers('return=minimal') });
      if (!del.ok) throw new Error(`database ${del.status}`);
      tell(notifyAdmin, `🔌 ${r.tool_name} disconnected by the customer (request #${r.id}, chat ${me.chatId}). Their saved token was deleted; revoke it in the tool too if you want it fully gone.`);
      res.json({ ok: true });
    } catch (err) { fail(res, err, 'disconnect'); }
  });

  // For the agent's own use later: the saved token for one of this customer's connected tools, or null.
  async function getToken(chatId, slug) {
    if (!enabled) return null;
    const [c] = await rows(`tool_connections?chat_id=eq.${eq(chatId)}&slug=eq.${eq(slug)}&status=eq.connected&select=token_enc&limit=1`, { method: 'GET', headers: headers() });
    return c && c.token_enc ? open(key, c.token_enc) : null;
  }
  return { enabled, getToken };
}
