// The website's Schedule and Agents tabs talk to these doors (next to POST /web/chat):
//
//   GET  /web/schedule            the calendar (a week, or ?from=YYYY-MM-DD&days=42 for a month grid) + when agents will run
//   POST /web/schedule/event      add one calendar event (pressing the button is the "yes")
//   GET  /web/agents              the agents, what tools they could use, how many more are allowed
//   POST /web/agents              build an agent from the form
//   POST /web/agents/<id>/<run|pause|resume|delete|schedule|update>
//   GET  /web/connections         which of Google / GitHub / own AI key are linked (yes/no only, never a token)
//   POST /web/disconnect          { provider: google|github|model } unlink one (the website's confirm box is the "yes")
//   POST /web/account/delete      { confirm: "DELETE" } delete the account and its data (see account.js)
//   POST /web/agent/plan          { request, page } plan steps for the Agent extension (see agentpage.js)
//   POST /web/agent/log           { url, outcome, done, total } what happened after the plan (counts only)
//
// Same rules as the chat door: the login is checked with Supabase on every request, the person is whoever Supabase
// says, only the website's own address may call it, and requests are rate limited. This file only does the
// plumbing (login, address check, limits, reading the request); what each door DOES lives in server.js, passed in
// as `ops`. Nothing here logs what anyone typed.
import { createLimiter } from './webchat.js';

const ID_RE = /^a[0-9a-f]{4,12}$/;
const VERBS = new Set(['run', 'pause', 'resume', 'delete', 'schedule', 'update']);

export function mountWebApi(app, { express, auth, getTenant, ops, siteOrigin, extraOrigins = [], perUserPerMinute = 60, perIpPerMinute = 180, log = () => {}, onError = () => {} }) {
  const allowed = new Set([siteOrigin, ...extraOrigins].filter(Boolean));
  const userLimit = createLimiter({ max: perUserPerMinute });
  const ipLimit = createLimiter({ max: perIpPerMinute });
  const router = express.Router();

  const cors = (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' });
    const origin = req.get('origin');
    if (origin && allowed.has(origin)) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type, ngrok-skip-browser-warning',
        'Access-Control-Max-Age': '600',
      });
    } else if (origin) {
      return res.status(403).json({ error: 'origin not allowed' });
    }
    next();
  };
  const limitIp = (req, res, next) => (ipLimit(req.ip || 'x') ? next() : res.status(429).json({ error: 'too many requests' }));

  // who is asking? -> sets req.tenant, or answers 401 / 503 / 409 itself
  const who = async (req, res, next) => {
    try {
      const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
      const v = await auth.verify(m ? m[1] : '');
      if (v.error === 'unauthorized') return res.status(401).json({ error: 'sign in again' });
      if (v.error) return res.status(503).json({ error: 'try again in a moment' });
      if (!userLimit(v.userId)) return res.status(429).json({ error: 'slow down a little' });
      const link = await auth.chatFor(v.userId);
      if (link.error === 'unavailable') return res.status(503).json({ error: 'try again in a moment' });
      const tenant = link.chatId ? getTenant(link.chatId) : null;
      if (!tenant) return res.status(409).json({ error: 'not_linked' });
      req.tenant = tenant;
      next();
    } catch (err) {
      try { onError('sign-in check', err); } catch { /* ignore */ }
      res.status(500).json({ error: 'something went wrong' });
    }
  };
  const run = (fn) => async (req, res) => {
    try {
      const out = await fn(req);
      res.status(out.status || 200).json(out.body ?? {});
    } catch (err) {
      console.error('[web api] failed:', err?.name || 'Error');
      try { onError(req.path.split('/')[1] || 'api', err); } catch { /* ignore */ }
      res.status(500).json({ error: 'something went wrong' });
    }
  };
  const json = express.json({ limit: '8kb' });

  router.options(['/schedule', '/schedule/event', '/agents', '/agents/:id/:verb', '/connections', '/disconnect', '/account/delete'], cors, (_req, res) => res.status(204).end());
  // The "Agent" browser extension calls these from its background worker (origin chrome-extension://<id>).
  // The login token is what authorises the call, same as the website; the origin check only keeps other websites out.
  const extIds = String(process.env.AGENT_EXTENSION_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
  const corsAgent = (req, res, next) => {
    const origin = req.get('origin');
    const ext = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin || '');
    if (origin && !(allowed.has(origin) || (ext && (!extIds.length || extIds.includes(ext[1]))))) return res.status(403).json({ error: 'origin not allowed' });
    if (origin) res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '600', Vary: 'Origin' });
    next();
  };
  const bigJson = express.json({ limit: '256kb' }); // a page snapshot is bigger than a normal request
  const planJson = express.json({ limit: '2mb' }); // ...and a plan may also carry one screenshot
  router.options(['/agent/plan', '/agent/log'], corsAgent, (_req, res) => res.status(204).end());
  router.post('/agent/plan', corsAgent, limitIp, planJson, who, run((req) => ops.agentPlan(req.tenant, req.body && typeof req.body === 'object' ? req.body : {})));
  router.post('/agent/log', corsAgent, limitIp, json, who, run((req) => ops.agentLog(req.tenant, req.body && typeof req.body === 'object' ? req.body : {})));
  router.get('/connections', cors, limitIp, who, run((req) => ops.connections(req.tenant)));
  router.post('/disconnect', cors, limitIp, json, who, run((req) => ops.disconnect(req.tenant, String(req.body?.provider || ''))));
  router.post('/account/delete', cors, limitIp, json, who, run((req) => ops.deleteAccount(req.tenant, req.body && typeof req.body === 'object' ? req.body : {})));
  router.get('/schedule', cors, limitIp, who, run((req) => ops.schedule(req.tenant, Math.min(42, Math.max(1, parseInt(req.query.days, 10) || 7)), /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? String(req.query.from) : null)));
  router.post('/schedule/event', cors, limitIp, json, who, run((req) => ops.addEvent(req.tenant, req.body && typeof req.body === 'object' ? req.body : {})));
  router.get('/agents', cors, limitIp, who, run((req) => ops.agents(req.tenant)));
  router.post('/agents', cors, limitIp, json, who, run((req) => ops.createAgent(req.tenant, req.body && typeof req.body === 'object' ? req.body : {})));
  router.post('/agents/:id/:verb', cors, limitIp, json, who, run((req) => {
    if (!ID_RE.test(req.params.id) || !VERBS.has(req.params.verb)) return { status: 404, body: { error: 'not found' } };
    return ops.agentVerb(req.tenant, req.params.id, req.params.verb, req.body && typeof req.body === 'object' ? req.body : {});
  }));
  app.use('/web', router);
  log('[web api] schedule and agents doors are mounted');
}
