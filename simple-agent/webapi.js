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

export function mountWebApi(app, { express, auth, getTenant, ops, office = null, knowledge = null, siteOrigin, extraOrigins = [], perUserPerMinute = 60, perIpPerMinute = 180, log = () => {}, onError = () => {} }) {
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
  // `who` is for the owner's own agent (schedule, agents, connections, account). `whoAgent` is for the
  // Agent extension's two doors, which an office's employees may use too.
  const who = (req, res, next) => gate(req, res, next, false);
  const whoAgent = (req, res, next) => gate(req, res, next, true);
  const gate = async (req, res, next, agent) => {
    try {
      const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
      const v = await auth.verify(m ? m[1] : '');
      if (v.error === 'unauthorized') return res.status(401).json({ error: 'sign in again' });
      if (v.error) return res.status(503).json({ error: 'try again in a moment' });
      if (!userLimit(v.userId)) return res.status(429).json({ error: 'slow down a little' });
      let link = await auth.chatFor(v.userId, { agent });
      // someone an office invited, signing in to the extension before the dashboard: link them now
      if (link.error === 'unlinked' && agent && office?.enabled && v.email && (await office.claim(v.userId, v.email, v.emailConfirmed)).ok) link = await auth.chatFor(v.userId, { agent });
      if (link.error === 'unavailable') return res.status(503).json({ error: 'try again in a moment' });
      if (link.error === 'employee') return res.status(403).json({ error: 'owner_only', message: 'This part belongs to your office’s owner.' });
      const tenant = link.chatId ? getTenant(link.chatId) : null;
      if (!tenant) return res.status(409).json({ error: 'not_linked' });
      req.tenant = tenant;
      req.userId = v.userId;
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
  router.post('/agent/plan', corsAgent, limitIp, planJson, whoAgent, run((req) => ops.agentPlan(req.tenant, req.body && typeof req.body === 'object' ? req.body : {})));
  router.post('/agent/log', corsAgent, limitIp, bigJson, whoAgent, run((req) => ops.agentLog(req.tenant, req.body && typeof req.body === 'object' ? req.body : {}, req.userId)));

  // ---- the Office dashboard (owner / employee). Signed in with the same login; reads only that person's
  //      business, and only their own work unless they're the owner.
  const whoOffice = async (req, res, next) => {
    try {
      if (!office?.enabled) return res.status(503).json({ error: 'try again in a moment' });
      const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
      const v = await auth.verify(m ? m[1] : '');
      if (v.error === 'unauthorized') return res.status(401).json({ error: 'sign in again' });
      if (v.error) return res.status(503).json({ error: 'try again in a moment' });
      if (!userLimit(v.userId)) return res.status(429).json({ error: 'slow down a little' });
      let member = await office.member(v.userId);
      // first sign-in after an invite: match it by their confirmed email, then look again
      if (member.error === 'not_member' && v.email && (await office.claim(v.userId, v.email, v.emailConfirmed)).ok) member = await office.member(v.userId);
      if (member.error === 'unavailable') return res.status(503).json({ error: 'try again in a moment' });
      if (member.error) {
        // not in an office, but has their own Agent: the page sends them there instead
        const link = await auth.chatFor(v.userId).catch(() => ({}));
        const agent = !!link?.chatId && (await office.hasAgent(link.chatId));
        return res.status(403).json({ error: 'not_member', hasAgent: agent, message: 'This login isn’t part of an office yet. Ask your office’s owner to add your email.' });
      }
      req.member = { ...member, userId: v.userId };
      next();
    } catch (err) {
      try { onError('office sign-in check', err); } catch { /* ignore */ }
      res.status(500).json({ error: 'something went wrong' });
    }
  };
  const person = (req) => (/^[0-9a-f-]{36}$/i.test(String(req.query.person || '')) ? String(req.query.person) : '');
  router.options(['/office/me', '/office/activity', '/office/summary', '/office/team', '/office/team/invite', '/office/team/resend', '/office/team/remove', '/office/me/name', '/office/knowledge', '/office/knowledge/item', '/office/knowledge/file', '/office/knowledge/note', '/office/knowledge/upload', '/office/knowledge/review', '/office/knowledge/remove', '/office/rules'], cors, (_req, res) => res.status(204).end());
  router.get('/office/me', cors, limitIp, whoOffice, run(async (req) => {
    const b = await office.business(req.member.chatId);
    // only an owner whose business also signed up for Agent gets the link over to the Agent dashboard
    const hasAgent = req.member.role === 'owner' ? await office.hasAgent(req.member.chatId) : false;
    const pending = req.member.role === 'owner' && knowledge?.enabled ? await knowledge.pendingCount(req.member.chatId) : 0;
    return { body: { business: b || { name: 'Your office', accent: null }, role: req.member.role, email: req.member.email, name: req.member.name, hasAgent, pending } };
  }));
  router.post('/office/me/name', cors, limitIp, json, whoOffice, run(async (req) => {
    const r = await office.rename(req.member, req.body?.name);
    if (r.error === 'bad_name') return { status: 400, body: { error: 'bad_name', message: 'Type a name.' } };
    return r.error ? { status: 503, body: { error: 'try again in a moment' } } : { body: { ok: true, name: r.name } };
  }));
  router.get('/office/activity', cors, limitIp, whoOffice, run(async (req) => {
    const limit = 30;
    const a = await office.activity(req.member, { person: person(req), before: String(req.query.before || ''), limit: limit + 1 });
    if (a.error) return { status: 503, body: { error: 'try again in a moment' } };
    return { body: { rows: a.rows.slice(0, limit), more: a.rows.length > limit } };
  }));
  router.get('/office/summary', cors, limitIp, whoOffice, run(async (req) => {
    const s = await office.summary(req.member, { person: person(req) });
    return s.error ? { status: 503, body: { error: 'try again in a moment' } } : { body: s };
  }));
  router.get('/office/team', cors, limitIp, whoOffice, run(async (req) => {
    const t = await office.team(req.member);
    return t.error ? { status: 503, body: { error: 'try again in a moment' } } : { body: t };
  }));

  // ---- Team (owner only): invite by email, send the invite again, remove someone
  const TEAM_ERR = {
    owner_only: [403, 'Only the office’s owner can change the team.'],
    bad_email: [400, 'That doesn’t look like an email address.'],
    taken: [409, 'That email already belongs to another office. One email can only be in one office.'],
    already_member: [409, 'That person is already on your team.'],
    not_found: [404, 'That person isn’t on your team any more.'],
    cant_remove_owner: [400, 'The owner can’t be removed.'],
    unavailable: [503, 'Try again in a moment.'],
  };
  const teamOut = (r) => {
    if (r.error) { const [status, message] = TEAM_ERR[r.error] || [503, 'Try again in a moment.']; return { status, body: { error: r.error, message } }; }
    const note = r.existing && r.sent ? 'They already had a login, so we emailed them a link to set their password.'
      : r.sent ? 'Invite sent. They’ll get an email to set their password.'
      : r.emailError === 'rate_limited' ? 'They’re added, but too many emails went out this hour. Use “Send again” in a little while.'
      : r.sent === false ? 'They’re added, but the invite email couldn’t be sent. Check the email settings in Supabase, then use “Send again”.' : '';
    return { body: { ok: true, sent: r.sent === true, existing: r.existing === true, emailProblem: r.sent === false, note } };
  };
  const inviteOpts = { redirectTo: siteOrigin ? `${siteOrigin}/office/` : undefined };
  router.post('/office/team/invite', cors, limitIp, json, whoOffice, run(async (req) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const biz = await office.business(req.member.chatId);
    return teamOut(await office.invite(req.member, { email: b.email, name: b.name }, { ...inviteOpts, office: biz?.name }));
  }));
  router.post('/office/team/resend', cors, limitIp, json, whoOffice, run(async (req) => {
    const biz = await office.business(req.member.chatId);
    return teamOut(await office.resend(req.member, String(req.body?.memberId ?? ''), { ...inviteOpts, office: biz?.name }));
  }));
  router.post('/office/team/remove', cors, limitIp, json, whoOffice, run(async (req) => {
    const r = await office.remove(req.member, String(req.body?.memberId ?? ''));
    if (r.ok && r.userId) auth.forgetLink?.(r.userId); // cut the extension off right away too
    return r.error ? teamOut(r) : { body: { ok: true } };
  }));
  // ---- Rules (rules.js): everyone in the office can read them; only the owner changes them.
  const RULE_ERR = {
    bad_site: (r) => `“${r.site}” isn’t a website address. Use something like example.com.`,
    too_many_sites: () => 'That’s too many sites for one list (100 at most).',
    empty_allow: () => 'Add at least one site, or choose “Any site”. Otherwise Agent couldn’t work anywhere.',
    owner_only: () => 'Only your office’s owner can change the rules.',
  };
  router.get('/office/rules', cors, limitIp, whoOffice, run(async (req) => {
    const r = await office.rulesFor(req.member.chatId);
    if (r?.error) return { status: 503, body: { error: 'try again in a moment' } };
    return { body: { rules: r || null, canEdit: req.member.role === 'owner' } };
  }));
  router.post('/office/rules', cors, limitIp, json, whoOffice, run(async (req) => {
    const r = await office.setRules(req.member, req.body?.rules);
    if (r.error === 'unavailable') return { status: 503, body: { error: 'try again in a moment', message: 'Couldn’t save the rules right now. Try again in a moment.' } };
    if (r.error) return { status: r.error === 'owner_only' ? 403 : 400, body: { error: r.error, message: (RULE_ERR[r.error] || (() => 'Couldn’t save those rules.'))(r) } };
    return { body: { ok: true, rules: r.rules } };
  }));

  // ---- Knowledge: notes and files for Agent. Employees' wait for the owner's approval (knowledge.js).
  const KN_ERR = {
    no_title: [400, 'Give it a short title.'], no_text: [400, 'Type the note.'], too_long: [400, 'That note is too long. Keep it under 5,000 characters.'],
    too_many_waiting: [429, 'You have 25 things waiting for approval. Ask your owner to review them first.'], full: [409, 'Your office has reached 1,000 items. Remove some old ones first.'],
    owner_only: [403, 'Only your office’s owner can do that.'], not_found: [404, 'That item isn’t there anymore.'], already_reviewed: [409, 'That was already reviewed.'],
    bad_decision: [400, 'Choose approve or reject.'], unavailable: [503, 'Couldn’t do that right now. Try again in a moment.'],
  };
  const knOut = (r) => {
    if (!r.error) return null;
    if (r.message) return { status: 400, body: { error: r.error, message: r.message } }; // from reading the file
    const [status, message] = KN_ERR[r.error] || [500, 'Something went wrong.'];
    return { status, body: { error: r.error, message } };
  };
  const needKn = (req, res, next) => (knowledge?.enabled ? next() : res.status(503).json({ error: 'try again in a moment' }));
  const knId = (v) => String(v ?? '').slice(0, 40);
  router.get('/office/knowledge', cors, limitIp, needKn, whoOffice, run(async (req) => {
    const r = await knowledge.list(req.member);
    return knOut(r) || { body: { items: r.items, excel: knowledge.excel, pdf: !!knowledge.pdf, word: !!knowledge.word } };
  }));
  router.get('/office/knowledge/item', cors, limitIp, needKn, whoOffice, run(async (req) => {
    const r = await knowledge.read(req.member, knId(req.query.id));
    return knOut(r) || { body: { item: r.item } };
  }));
  router.post('/office/knowledge/note', cors, limitIp, needKn, json, whoOffice, run(async (req) => {
    const r = await knowledge.addNote(req.member, { title: req.body?.title, text: req.body?.text });
    return knOut(r) || { body: { ok: true, id: r.id, status: r.status } };
  }));
  // The file is the request body as-is (up to 10 MB), read only AFTER the sign-in check so strangers can't
  // make us hold big uploads. The name and title ride in the address.
  const rawFile = express.raw({ type: () => true, limit: '10mb' });
  router.post('/office/knowledge/upload', cors, limitIp, needKn, whoOffice, (req, res, next) => rawFile(req, res, (err) => {
    if (err) return res.status(err.status === 413 ? 413 : 400).json({ error: 'too_big', message: err.status === 413 ? 'That file is over 10 MB.' : 'Couldn’t read that upload.' });
    next();
  }), run(async (req) => {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const r = await knowledge.addFile(req.member, { name: String(req.query.name || ''), title: String(req.query.title || ''), buf });
    return knOut(r) || { body: { ok: true, id: r.id, status: r.status } };
  }));
  router.post('/office/knowledge/review', cors, limitIp, needKn, json, whoOffice, run(async (req) => {
    const r = await knowledge.review(req.member, knId(req.body?.id), String(req.body?.decision || ''), req.body?.note);
    return knOut(r) || { body: { ok: true, status: r.status } };
  }));
  router.post('/office/knowledge/remove', cors, limitIp, needKn, json, whoOffice, run(async (req) => {
    const r = await knowledge.remove(req.member, knId(req.body?.id));
    return knOut(r) || { body: { ok: true } };
  }));
  // The original file: always a download (never shown in the browser), with a safe name.
  router.get('/office/knowledge/file', cors, limitIp, needKn, whoOffice, async (req, res) => {
    try {
      const r = await knowledge.download(req.member, knId(req.query.id));
      if (r.error) { const o = knOut(r); return res.status(o.status).json(o.body); }
      const ascii = r.name.replace(/[^A-Za-z0-9._ -]/g, '_');
      res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(r.name)}`, 'Content-Security-Policy': "default-src 'none'; sandbox" });
      res.status(200).send(r.buf);
    } catch (err) {
      try { onError('knowledge download', err); } catch { /* ignore */ }
      res.status(500).json({ error: 'something went wrong' });
    }
  });

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
