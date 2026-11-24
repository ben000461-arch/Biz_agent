// Agent (powered by co|op): background worker.
// - Holds the sign-in (in the extension's own storage; web pages can never read it) and refreshes it.
// - Talks to the agent server for the page bar, so the login token never touches the web page.
// - Opens the bar when the shortcut is pressed, and brings it along when Agent (or the employee) moves to another
//   tab during a chat. It only ever acts on a page after the employee asks; nothing runs in the background.
import { CONFIG } from './config.js';

const SESSION_KEY = 'agentSession';
const SETTINGS_KEY = 'agentSettings';

async function settings() {
  const s = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
  // a developer may point the extension at a local agent; only https or localhost are accepted
  const ok = typeof s.apiBase === 'string' && /^(https:\/\/[^\s/]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(s.apiBase);
  return { apiBase: ok ? s.apiBase : CONFIG.API_BASE, brand: s.brand && typeof s.brand === 'object' ? s.brand : null };
}

async function supa(path, body) {
  const res = await fetch(`${CONFIG.SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: CONFIG.SUPABASE_PUBLISHABLE_KEY },
    body: JSON.stringify(body),
  });
  let out = null; try { out = await res.json(); } catch { /* ignore */ }
  return { ok: res.ok, status: res.status, body: out };
}

function keep(r) {
  const b = r.body || {};
  return { access_token: b.access_token, refresh_token: b.refresh_token, expires_at: Date.now() + (Number(b.expires_in) || 3600) * 1000, email: b.user?.email || '' };
}

async function signIn(email, password) {
  const r = await supa('/auth/v1/token?grant_type=password', { email: String(email || '').trim(), password: String(password || '') });
  if (!r.ok || !r.body?.access_token) {
    const msg = r.status === 400 || r.status === 401 ? 'That email and password didn’t match. If you usually sign in with an email link, set a password first in your dashboard under Settings → Password.' : 'Couldn’t reach the sign-in service. Try again in a moment.';
    return { ok: false, message: msg };
  }
  await chrome.storage.local.set({ [SESSION_KEY]: keep(r) });
  return { ok: true, email: r.body.user?.email || '' };
}

async function signOut() {
  const s = (await chrome.storage.local.get(SESSION_KEY))[SESSION_KEY];
  if (s?.access_token) {
    try { await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/logout`, { method: 'POST', headers: { apikey: CONFIG.SUPABASE_PUBLISHABLE_KEY, authorization: `Bearer ${s.access_token}` } }); } catch { /* ignore */ }
  }
  await chrome.storage.local.remove(SESSION_KEY);
}

// a valid access token, refreshed when it's about to run out; null when signed out
async function token() {
  const s = (await chrome.storage.local.get(SESSION_KEY))[SESSION_KEY];
  if (!s?.access_token) return null;
  if (Date.now() < s.expires_at - 60_000) return s.access_token;
  if (!s.refresh_token) return null;
  const r = await supa('/auth/v1/token?grant_type=refresh_token', { refresh_token: s.refresh_token });
  if (!r.ok || !r.body?.access_token) { await chrome.storage.local.remove(SESSION_KEY); return null; }
  const next = keep(r); next.email = next.email || s.email;
  await chrome.storage.local.set({ [SESSION_KEY]: next });
  return next.access_token;
}

const PLAIN = {
  401: 'Your sign-in ran out. Click the Agent icon in the toolbar and sign in again.',
  409: 'Your login isn’t linked to an agent yet. Finish setup in your dashboard first.',
  429: 'Slow down a little and try again in a minute.',
  503: 'The agent is busy or offline right now. Nothing was changed. Try again in a moment.',
};

async function api(path, body) {
  const t = await token();
  if (!t) return { ok: false, signedOut: true, message: 'Sign in first: click the Agent icon in your toolbar.' };
  const { apiBase } = await settings();
  let res;
  try {
    res = await fetch(`${apiBase}/web${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    return { ok: false, message: 'Couldn’t reach your agent. Check your connection. Nothing was changed.' };
  }
  let out = null; try { out = await res.json(); } catch { /* ignore */ }
  if (res.ok) return { ok: true, body: out || {} };
  if (res.status === 401) await chrome.storage.local.remove(SESSION_KEY);
  return { ok: false, status: res.status, signedOut: res.status === 401, message: (out && typeof out.message === 'string' && out.message) || PLAIN[res.status] || 'Something went wrong. Nothing was changed.' };
}

async function openBar(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return { ok: true };
  } catch {
    return { ok: false, message: 'Agent can’t open on this page (browser pages, the Chrome Web Store and PDFs are off limits).' };
  }
}

// ---- One chat that follows you across tabs.
// The conversation is kept per browser window in session storage (cleared when the browser closes; never sent
// anywhere). When Agent opens or switches to a tab, or the employee switches tabs while the chat is open, the
// bar shows up there with the same conversation. Closing the bar (×) stops it following.
const convoKey = (windowId) => `convo:${windowId}`;
const pendingKey = (tabId) => `pending:${tabId}`;
const sget = async (k) => (await chrome.storage.session.get(k))[k];
const webPage = (url) => /^https?:\/\//.test(String(url || '')) && !/^https:\/\/chromewebstore\.google\.com|^https:\/\/chrome\.google\.com\/webstore/.test(url);
const showing = new Map(); // tabId -> promise, so two calls never inject twice
function showBar(tabId) {
  if (showing.has(tabId)) return showing.get(tabId);
  const p = (async () => {
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => { if (window.__agentBar) { window.__agentBar.resume(); return true; } return false; } });
      if (!r?.result) await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      return true;
    } catch { return false; } finally { setTimeout(() => showing.delete(tabId), 300); }
  })();
  showing.set(tabId, p);
  return p;
}
function whenLoaded(tabId, ms = 20000) {
  return new Promise((resolve) => {
    let t = null;
    const done = (ok) => { clearTimeout(t); chrome.tabs.onUpdated.removeListener(on); resolve(ok); };
    const on = (id, info) => { if (id === tabId && info.status === 'complete') done(true); };
    chrome.tabs.onUpdated.addListener(on);
    t = setTimeout(() => done(false), ms);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') done(true); }).catch(() => done(false));
  });
}
async function goTab(sender, msg) {
  const from = sender?.tab; if (!from) return { ok: false };
  let tab;
  try {
    if (msg.url) {
      let u; try { u = new URL(String(msg.url)); } catch { return { ok: false, message: 'that isn’t a web address' }; }
      if (!/^https?:$/.test(u.protocol)) return { ok: false, message: 'that isn’t a web address' };
      tab = await chrome.tabs.create({ url: u.href, windowId: from.windowId, openerTabId: from.id, index: from.index + 1, active: true });
    } else {
      tab = await chrome.tabs.get(Number(msg.tabId));
      if (tab.windowId !== from.windowId) return { ok: false, message: 'that tab is in another window' };
      await chrome.tabs.update(tab.id, { active: true });
    }
  } catch { return { ok: false, message: 'that tab couldn’t be opened' }; }
  const carry = msg.carry && typeof msg.carry === 'object' ? {
    request: String(msg.carry.request || '').slice(0, 1000), round: Math.max(2, Math.min(10, Number(msg.carry.round) || 2)),
    history: Array.isArray(msg.carry.history) ? msg.carry.history.slice(-14) : [], approvedTask: msg.carry.approvedTask ? String(msg.carry.approvedTask).slice(0, 1000) : null,
  } : null;
  if (carry && carry.round <= 10) await chrome.storage.session.set({ [pendingKey(tab.id)]: carry });
  // show the bar there once the page has loaded (don't keep the old tab waiting)
  whenLoaded(tab.id).then((ok) => (ok && webPage(tab.url || msg.url) ? showBar(tab.id) : null));
  return { ok: true };
}
async function otherTabs(sender) {
  const from = sender?.tab; if (!from) return { tabs: [] };
  const tabs = await chrome.tabs.query({ windowId: from.windowId });
  return { tabs: tabs.filter((t) => webPage(t.url)).slice(0, 20).map((t) => {
    let host = ''; try { host = new URL(t.url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
    return { id: t.id, title: String(t.title || host).slice(0, 120), host, current: t.id === from.id };
  }) };
}
// the employee switches tabs (or a page in the chat's tab reloads) while the chat is open: bring the bar along
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (!(await sget(convoKey(windowId)))) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && tab.status === 'complete' && webPage(tab.url)) showBar(tabId);
});
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete' || !tab.active || !webPage(tab.url)) return;
  if ((await sget(convoKey(tab.windowId))) || (await sget(pendingKey(tabId)))) showBar(tabId);
});
chrome.windows.onRemoved.addListener((windowId) => chrome.storage.session.remove(convoKey(windowId)));
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(pendingKey(tabId)));

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-agent') return;
  const t = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (t?.id != null) await openBar(t.id);
});

// The text of the Google Doc open in the asking tab, from Docs' own plain-text export, with the employee's own
// Google login. Only ever the doc in that same tab; nothing is stored. (Docs sends the file from a
// googleusercontent.com address, which is why this runs here and not on the page.)
async function docText(tabUrl, format = 'txt') {
  let u; try { u = new URL(String(tabUrl || '')); } catch { return { ok: false }; }
  const m = u.pathname.match(/\/(document|presentation)\/d\/([\w-]{10,})/);
  const google = u.origin === 'https://docs.google.com';
  const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(u.origin); // for testing only
  if (!m || !(google || local)) return { ok: false };
  const [, kind, id] = m;
  if (kind === 'presentation' && format === 'html') return { ok: false }; // Slides has no formatted text export
  const url = kind === 'presentation' ? `${u.origin}/presentation/d/${id}/export/txt` : `${u.origin}/document/d/${id}/export?format=${format === 'html' ? 'html' : 'txt'}`;
  try {
    const r = await fetch(url, { credentials: google ? 'include' : 'omit', cache: 'no-store' });
    if (!r.ok) return { ok: false };
    return { ok: true, text: (await r.text()).slice(0, 400000) };
  } catch { return { ok: false }; }
}

// ---- Real mouse and keyboard, for apps that ignore simulated clicks (Google Slides' canvas, drawing tools).
// Only the tab the employee asked Agent to work in, only for the step that needs it, then let go. While it's on,
// Chrome shows its own "started debugging this browser" bar; that's Chrome's safety notice and can't be hidden.
const attached = new Set();
const letGo = new Map();
chrome.debugger.onDetach.addListener((src) => attached.delete(src.tabId));
const cdp = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  SelectAll: { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, commands: ['selectAll'] },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
};
async function realInput(tabId, actions, mac) {
  if (!tabId) return { ok: false };
  try {
    if (!attached.has(tabId)) { await chrome.debugger.attach({ tabId }, '1.3'); attached.add(tabId); }
    clearTimeout(letGo.get(tabId));
    for (const a of (Array.isArray(actions) ? actions : []).slice(0, 20)) {
      if (a.t === 'click' || a.t === 'dblclick') {
        const x = Number(a.x), y = Number(a.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        for (let i = 1; i <= (a.t === 'dblclick' ? 2 : 1); i++) {
          await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: i });
          await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: i });
        }
      } else if (a.t === 'type' && typeof a.text === 'string') {
        await cdp(tabId, 'Input.insertText', { text: a.text.slice(0, 12000) });
      } else if (a.t === 'key' && KEYS[a.key]) {
        const k = KEYS[a.key];
        const modifiers = a.key === 'SelectAll' ? (mac ? 4 : 2) : 0; // ⌘ on Mac, Ctrl elsewhere
        await cdp(tabId, 'Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', modifiers, ...k });
        await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    letGo.set(tabId, setTimeout(() => { chrome.debugger.detach({ tabId }).catch(() => {}); attached.delete(tabId); }, 4000));
    return { ok: true };
  } catch { return { ok: false }; }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    switch (msg?.type) {
      case 'status': {
        const s = (await chrome.storage.local.get(SESSION_KEY))[SESSION_KEY];
        const t = await token();
        return { signedIn: Boolean(t), email: s?.email || '', ...(await settings()) };
      }
      case 'signIn': return signIn(msg.email, msg.password);
      case 'signOut': await signOut(); return { ok: true };
      case 'open': return openBar(msg.tabId);
      case 'boot': { // a bar starting up: the chat for this window, and a task to carry on if Agent just moved here
        const tab = sender?.tab; if (!tab) return {};
        const pending = await sget(pendingKey(tab.id));
        if (pending) await chrome.storage.session.remove(pendingKey(tab.id));
        return { convo: (await sget(convoKey(tab.windowId))) || null, pending: pending || null };
      }
      case 'convoSave': {
        const tab = sender?.tab; if (!tab || !msg.convo || typeof msg.convo !== 'object') return { ok: false };
        const c = msg.convo;
        const convo = { items: Array.isArray(c.items) ? c.items.slice(-40) : [], history: Array.isArray(c.history) ? c.history.slice(-14) : [], approvedTask: c.approvedTask ? String(c.approvedTask).slice(0, 1000) : null, folded: c.folded === true };
        if (JSON.stringify(convo).length > 200000) convo.items = convo.items.slice(-15);
        await chrome.storage.session.set({ [convoKey(tab.windowId)]: convo });
        return { ok: true };
      }
      case 'convoEnd': { const tab = sender?.tab; if (tab) await chrome.storage.session.remove(convoKey(tab.windowId)); return { ok: true }; }
      case 'tabs': return otherTabs(sender);
      case 'goTab': return goTab(sender, msg);
      case 'plan': return api('/agent/plan', { request: String(msg.request || '').slice(0, 1000), page: msg.page, history: Array.isArray(msg.history) ? msg.history.slice(-14) : [], round: Number(msg.round) || 1,
        ...(typeof msg.screenshot === 'string' && msg.screenshot.length < 2_000_000 ? { screenshot: msg.screenshot } : {}),
        ...(typeof msg.failure === 'string' && msg.failure ? { failure: msg.failure.slice(0, 400) } : {}) });
      // a picture of the tab the employee is on (only that tab, only when they asked Agent for something)
      case 'shot': return chrome.tabs.captureVisibleTab(sender?.tab?.windowId, { format: 'jpeg', quality: 70 }).then((dataUrl) => ({ ok: true, dataUrl })).catch(() => ({ ok: false }));
      case 'docText': return docText(sender?.tab?.url, msg.format);
      case 'real': return realInput(sender?.tab?.id, msg.actions, msg.mac === true);
      case 'log': return api('/agent/log', { url: msg.url, outcome: msg.outcome, done: msg.done, total: msg.total, auto: msg.auto === true, denied: msg.denied === true,
        request: String(msg.request || '').slice(0, 500), steps: (Array.isArray(msg.steps) ? msg.steps : []).slice(0, 25).map((x) => ({ what: String(x?.what || '').slice(0, 140), ok: x?.ok === true })) });
      default: return { ok: false };
    }
  })().then(reply, () => reply({ ok: false, message: 'Something went wrong. Nothing was changed.' }));
  return true; // answer asynchronously
});
