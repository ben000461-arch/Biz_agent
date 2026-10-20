// Ties a Telegram chat to a website login, using the one-time code the website hands out.
//
// The code is looked up AND deleted in one request, so a code can only ever be used once, even if two
// taps arrive at the same moment. Only then is the login tied to the chat. Uses the Supabase REST API
// with the service key (same as the action log). Nothing here throws into the caller; every outcome is
// a plain result the bot turns into a friendly message.

const CODE_RE = /^[a-f0-9]{32}$/;

export function createLinker({ url, key, fetchImpl = globalThis.fetch, timeoutMs = 8000, now = () => Date.now() } = {}) {
  const base = String(url || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  const secret = String(key || '').trim();
  const enabled = Boolean(base && secret);

  const headers = (prefer) => {
    const h = { 'content-type': 'application/json', apikey: secret };
    if (secret.startsWith('eyJ')) h.authorization = `Bearer ${secret}`; // only old-style JWT keys go here too
    if (prefer) h.Prefer = prefer;
    return h;
  };

  async function call(path, opts) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await fetchImpl(`${base}/rest/v1/${path}`, { ...opts, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // Look at a code WITHOUT using it up. -> { userId, email } | { error: 'invalid' | 'expired' | 'unavailable' }
  async function peek(code) {
    if (!enabled) return { error: 'unavailable' };
    const c = String(code || '').trim().toLowerCase();
    if (!CODE_RE.test(c)) return { error: 'invalid' }; // never put anything but 32 hex characters in a URL
    let row;
    try {
      const res = await call(`link_codes?code=eq.${c}&select=user_id,email,expires_at&limit=1`, { method: 'GET', headers: headers() });
      if (!res.ok) return { error: 'unavailable' };
      const rows = await res.json();
      row = Array.isArray(rows) ? rows[0] : null;
    } catch {
      return { error: 'unavailable' };
    }
    if (!row || !row.user_id) return { error: 'invalid' };
    if (new Date(row.expires_at).getTime() < now()) return { error: 'expired' };
    return { userId: row.user_id, email: row.email || '' };
  }

  // Use the code up: it is looked up AND deleted in one request, so only one caller can ever win.
  // -> { userId, email } | { error: 'invalid' | 'expired' | 'unavailable' }
  async function claim(code) {
    if (!enabled) return { error: 'unavailable' };
    const c = String(code || '').trim().toLowerCase();
    if (!CODE_RE.test(c)) return { error: 'invalid' };
    let row;
    try {
      const res = await call(`link_codes?code=eq.${c}`, { method: 'DELETE', headers: headers('return=representation') });
      if (!res.ok) return { error: 'unavailable' };
      const rows = await res.json();
      row = Array.isArray(rows) ? rows[0] : null;
    } catch {
      return { error: 'unavailable' };
    }
    if (!row || !row.user_id) return { error: 'invalid' }; // never existed, or already used
    if (new Date(row.expires_at).getTime() < now()) return { error: 'expired' };
    return { userId: row.user_id, email: row.email || '' };
  }

  // Tie a website login to a chat. -> { ok: true } | { error: 'failed' }
  async function link(userId, chatId) {
    try {
      const res = await call('tenant_users?on_conflict=user_id', {
        method: 'POST',
        headers: headers('resolution=merge-duplicates,return=minimal'),
        body: JSON.stringify({ user_id: userId, chat_id: String(chatId) }),
      });
      return res.ok ? { ok: true } : { error: 'failed' };
    } catch {
      return { error: 'failed' };
    }
  }

  // -> { ok: true, email } | { error: 'invalid' | 'expired' | 'unavailable' | 'failed' }
  async function redeem(code, chatId) {
    const c = await claim(code);
    if (c.error) return c;
    const l = await link(c.userId, chatId);
    return l.error ? l : { ok: true, email: c.email };
  }

  // Remove every website login tied to this chat. -> { removed: n } | { error }
  async function unlink(chatId) {
    if (!enabled) return { error: 'unavailable' };
    try {
      const res = await call(`tenant_users?chat_id=eq.${encodeURIComponent(String(chatId))}`, { method: 'DELETE', headers: headers('return=representation') });
      if (!res.ok) return { error: 'unavailable' };
      const rows = await res.json();
      return { removed: Array.isArray(rows) ? rows.length : 0 };
    } catch {
      return { error: 'unavailable' };
    }
  }

  return { enabled, peek, claim, link, redeem, unlink };
}