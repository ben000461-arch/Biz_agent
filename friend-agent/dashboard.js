// friend-agent — the small self-serve dashboard.
//
// One page, three jobs:
//   1. Show whether each connection (GitHub, Twilio, Groq) is actually
//      configured, so your friend doesn't have to read .env to know why
//      something isn't working.
//   2. Let him edit "extra instructions" for the agent — free-text notes
//      folded into the prompt that turns his texts into GitHub issues
//      (e.g. "always use TypeScript," "our repo's tests live in /test").
//   3. Show a live feed of what the bridge has actually done, so a text
//      that seems to vanish can be traced instead of just wondered about.
//
// This does NOT let him add brand-new tools/integrations — that's real
// scope (OAuth flows, credential storage, per-tool code) and isn't built
// here. What's here is genuinely everything the current bridge can show
// or take input on; see the README section this ships with for the honest
// line on what's still just env vars.
//
// No database — getLog()/getAgentInstructions() are in-memory (activity.js).
// No real auth beyond an optional shared password, since this runs on a
// personal box for one person, not as a public product.

import express from 'express';
import { getLog, getAgentInstructions, setAgentInstructions } from './activity.js';

const { DASHBOARD_PASSWORD } = process.env;

function requireDashboardAuth(req, res, next) {
  if (!DASHBOARD_PASSWORD) return next(); // no password set — dashboard is open, fine for local/ngrok testing
  const supplied = req.query.key || req.headers['x-dashboard-key'];
  if (supplied === DASHBOARD_PASSWORD) return next();
  res.status(401).send('Missing or wrong ?key= — ask whoever set up the bridge for the dashboard key.');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderPage(statusInfo) {
  const rows = Object.entries(statusInfo.connections)
    .map(([name, ok]) => `<tr><td>${escapeHtml(name)}</td><td class="${ok ? 'ok' : 'bad'}">${ok ? 'Connected' : 'Not configured'}</td></tr>`)
    .join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>friend-agent dashboard</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 16px; color: #1a1a1a; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 28px; }
  h2 { font-size: 15px; margin-top: 32px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  td { padding: 6px 4px; border-bottom: 1px solid #eee; }
  .ok { color: #1a7f37; font-weight: 600; }
  .bad { color: #b3261e; font-weight: 600; }
  textarea { width: 100%; min-height: 90px; font-family: inherit; font-size: 14px; padding: 8px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 6px; }
  button { margin-top: 8px; padding: 8px 14px; border-radius: 6px; border: none; background: #1a1a1a; color: white; font-size: 13px; cursor: pointer; }
  button:hover { background: #333; }
  #save-status { font-size: 13px; color: #1a7f37; margin-left: 8px; }
  #log { font-size: 13px; }
  .entry { padding: 8px 0; border-bottom: 1px solid #eee; }
  .entry .time { color: #888; font-size: 11px; }
  .entry .type { font-weight: 600; display: inline-block; min-width: 100px; }
  .meta { color: #888; font-size: 12px; }
  code { background: #f5f5f5; padding: 2px 5px; border-radius: 4px; }
</style>
</head>
<body>
  <h1>friend-agent</h1>
  <div class="sub">texting <code>${escapeHtml(statusInfo.repo)}</code> &middot; agent: <code>${escapeHtml(statusInfo.assignee)}</code></div>

  <h2>Connections</h2>
  <table>${rows}</table>

  <h2>Extra instructions for the agent</h2>
  <div class="meta">Folded into the prompt that turns your texts into GitHub issues. Good for stuff that's true every time — coding conventions, where tests live, things to avoid.</div>
  <textarea id="instructions" placeholder="e.g. Always write tests in /test. Prefer plain JS, no new dependencies without asking."></textarea>
  <br>
  <button onclick="saveInstructions()">Save</button>
  <span id="save-status"></span>

  <h2>Live activity</h2>
  <div class="meta">Updates every few seconds. Newest first.</div>
  <div id="log">Loading&hellip;</div>

<script>
  const KEY = new URLSearchParams(location.search).get('key');
  function withKey(url) { return KEY ? url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(KEY) : url; }

  async function loadInstructions() {
    const res = await fetch(withKey('/api/status'));
    if (!res.ok) return;
    const data = await res.json();
    document.getElementById('instructions').value = data.agentInstructions || '';
  }

  async function saveInstructions() {
    const text = document.getElementById('instructions').value;
    const res = await fetch(withKey('/api/config'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instructions: text }),
    });
    const el = document.getElementById('save-status');
    el.textContent = res.ok ? 'Saved.' : 'Failed to save.';
    setTimeout(() => (el.textContent = ''), 2000);
  }

  function typeLabel(t) {
    return ({
      'sms-in': 'Message in', 'issue-created': 'Issue created', 'issue-failed': 'Issue failed',
      'ignored': 'Ignored', 'pr-opened': 'PR opened', 'pr-merged': 'PR merged',
      'checks-failed': 'Checks failed', 'webhook-rejected': 'Webhook rejected',
    })[t] || t;
  }

  async function loadLog() {
    const res = await fetch(withKey('/api/logs'));
    if (!res.ok) return;
    const entries = await res.json();
    document.getElementById('log').innerHTML = entries.length
      ? entries.map(e => \`<div class="entry"><span class="type">\${typeLabel(e.type)}</span>\${e.detail}<div class="time">\${new Date(e.time).toLocaleString()}</div></div>\`).join('')
      : '<div class="meta">Nothing yet — texts will show up here as they come in.</div>';
  }

  loadInstructions();
  loadLog();
  setInterval(loadLog, 3000);
</script>
</body>
</html>`;
}

// statusInfo: { connections: { GitHub: bool, Twilio: bool, Groq: bool }, repo: string, assignee: string }
export function mountDashboard(app, statusInfo) {
  app.use('/api', requireDashboardAuth);
  app.get('/', requireDashboardAuth, (req, res) => {
    res.type('html').send(renderPage(statusInfo));
  });

  app.get('/api/status', (req, res) => {
    res.json({ ...statusInfo, agentInstructions: getAgentInstructions() });
  });

  app.get('/api/logs', (req, res) => {
    res.json(getLog());
  });

  // server.js only applies express.urlencoded() globally (Twilio webhooks are
  // form-encoded) — apply JSON parsing just for this one route rather than
  // changing how the rest of the app parses bodies.
  app.post('/api/config', express.json(), (req, res) => {
    setAgentInstructions(req.body?.instructions || '');
    res.json({ ok: true });
  });
}