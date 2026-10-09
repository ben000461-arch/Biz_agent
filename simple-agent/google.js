// google.js — talks to Google on behalf of one business: the sign-in flow
// (OAuth), creating Gmail drafts, and reading the calendar. Nothing here sends
// email: the only Gmail permission asked for is "compose", and we only ever
// create drafts that wait in the owner's Drafts folder.

import crypto from 'crypto';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.readonly',
];

export class NeedsReconnect extends Error {}

export function createGoogle({ clientId, clientSecret, publicUrl, vault, bases = {} }) {
  const AUTH = bases.auth || 'https://accounts.google.com/o/oauth2/v2/auth';
  const TOKEN = bases.token || 'https://oauth2.googleapis.com/token';
  const REVOKE = bases.revoke || 'https://oauth2.googleapis.com/revoke';
  const GMAIL = bases.gmail || 'https://gmail.googleapis.com/gmail/v1';
  const CAL = bases.calendar || 'https://www.googleapis.com/calendar/v3';
  const redirectUri = `${String(publicUrl).replace(/\/$/, '')}/oauth/google/callback`;

  // state value -> which chat started the sign-in. Single use, 10 minutes.
  const pending = new Map();
  const STATE_TTL = 10 * 60 * 1000;

  // Short-lived access tokens, kept in memory only.
  const accessCache = new Map(); // chatId -> { token, expiresAt }

  async function tokenRequest(params) {
    const res = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  }

  async function googleFetch(url, token, init = {}) {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401) throw new NeedsReconnect('Google rejected the saved sign-in');
    if (!res.ok) throw new Error(`Google API error ${res.status}`);
    return res.json();
  }

  return {
    redirectUri,

    startSignIn(chatId) {
      for (const [s, v] of pending) if (Date.now() > v.expires) pending.delete(s);
      const state = crypto.randomBytes(16).toString('hex');
      pending.set(state, { chatId: String(chatId), expires: Date.now() + STATE_TTL });
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GOOGLE_SCOPES.join(' '),
        access_type: 'offline', // so we get a refresh token (stays connected)
        prompt: 'consent',
        state,
      });
      return `${AUTH}?${q}`;
    },

    // Called by the callback route. Returns { chatId, email } or throws.
    async finishSignIn(state, code) {
      const entry = pending.get(state);
      pending.delete(state); // single use, whatever happens next
      if (!entry || Date.now() > entry.expires) throw new Error('This sign-in link expired — send /connect again.');

      const { ok, data } = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
      if (!ok || !data.access_token) {
        // Google's reason (e.g. invalid_client = wrong secret, redirect_uri_mismatch). Never contains secrets.
        console.error(`Google token exchange failed: ${data.error || 'unknown'}${data.error_description ? ` — ${data.error_description}` : ''}`);
        throw new Error('Google did not accept the sign-in. Try /connect again.');
      }
      if (!data.refresh_token) throw new Error('Google did not grant lasting access. Remove "Biz Agent" in your Google account permissions, then try /connect again.');

      const granted = String(data.scope || '');
      const missing = GOOGLE_SCOPES.filter((s) => !granted.includes(s));
      if (missing.length) throw new Error('Some permissions were unticked on the Google screen. Try /connect again and leave them all ticked.');

      let email = null;
      try {
        const profile = await googleFetch(`${GMAIL}/users/me/profile`, data.access_token);
        email = profile.emailAddress || null;
      } catch { /* cosmetic only */ }

      vault.set(entry.chatId, 'google', { refresh_token: data.refresh_token }, { email });
      accessCache.set(entry.chatId, { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 - 60_000 });
      return { chatId: entry.chatId, email };
    },

    isConnected: (chatId) => Boolean(vault.get(chatId, 'google')),

    async accessToken(chatId) {
      const id = String(chatId);
      const cached = accessCache.get(id);
      if (cached && Date.now() < cached.expiresAt) return cached.token;

      const secret = vault.get(id, 'google');
      if (!secret) throw new NeedsReconnect('not connected');
      const { ok, data } = await tokenRequest({ grant_type: 'refresh_token', refresh_token: secret.refresh_token });
      if (!ok) {
        // invalid_grant = revoked, or a Testing-mode token past its 7 days.
        if (data.error === 'invalid_grant') {
          vault.remove(id, 'google');
          accessCache.delete(id);
          throw new NeedsReconnect('expired');
        }
        throw new Error('Could not refresh the Google sign-in');
      }
      accessCache.set(id, { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 - 60_000 });
      return data.access_token;
    },

    async disconnect(chatId) {
      const id = String(chatId);
      const secret = vault.get(id, 'google');
      accessCache.delete(id);
      vault.remove(id, 'google');
      if (secret) {
        try { // best effort: also revoke on Google's side
          await fetch(`${REVOKE}?token=${encodeURIComponent(secret.refresh_token)}`, { method: 'POST', signal: AbortSignal.timeout(10_000) });
        } catch { /* local removal already done */ }
      }
    },

    // Creates a draft in the owner's Gmail. Never sends.
    async createDraft(chatId, { to, subject, body }) {
      const token = await this.accessToken(chatId);
      const clean = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim(); // no header injection
      const headers = [];
      if (clean(to)) headers.push(`To: ${clean(to)}`);
      headers.push(`Subject: =?UTF-8?B?${Buffer.from(clean(subject), 'utf8').toString('base64')}?=`);
      headers.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64');
      const b64 = Buffer.from(String(body || ''), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
      const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${b64}`, 'utf8').toString('base64url');
      return googleFetch(`${GMAIL}/users/me/drafts`, token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { raw } }),
      });
    },

    // Upcoming events: when = "today" | "tomorrow" | "week"
    async listEvents(chatId, when, tz) {
      const token = await this.accessToken(chatId);
      const now = new Date();
      const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
      let from = now;
      let to;
      if (when === 'tomorrow') { from = startOfDay(new Date(now.getTime() + 864e5)); to = new Date(from.getTime() + 864e5); }
      else if (when === 'week') { to = new Date(now.getTime() + 7 * 864e5); }
      else { to = new Date(startOfDay(now).getTime() + 864e5); }
      const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '15' });
      const data = await googleFetch(`${CAL}/calendars/primary/events?${q}`, token);
      return (data.items || []).map((e) => ({
        title: e.summary || '(no title)',
        start: e.start?.dateTime || e.start?.date,
        allDay: Boolean(e.start?.date && !e.start?.dateTime),
      }));
    },
  };
}