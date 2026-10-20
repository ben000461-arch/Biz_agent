// Sign-up approvals. Reads and updates the "signups" table over the Supabase REST API with the service
// key. The website can never change a status; only this file (through the bot) can. Nothing here throws:
// every call returns a plain result.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS = 'user_id,email,use_case,business_type,business_name,notes,created_at';

export const shortId = (userId) => String(userId).replace(/-/g, '').slice(0, 12).toLowerCase();

export function createSignups({ url, key, fetchImpl = globalThis.fetch, timeoutMs = 8000, now = () => new Date() } = {}) {
  const base = String(url || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  const secret = String(key || '').trim();
  const enabled = Boolean(base && secret);

  const headers = (prefer) => {
    const h = { 'content-type': 'application/json', apikey: secret };
    if (secret.startsWith('eyJ')) h.authorization = `Bearer ${secret}`;
    if (prefer) h.Prefer = prefer;
    return h;
  };
  async function call(path, opts) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try { return await fetchImpl(`${base}/rest/v1/${path}`, { ...opts, signal: ctl.signal }); }
    finally { clearTimeout(timer); }
  }
  async function rows(path, opts) {
    try {
      const res = await call(path, opts);
      if (!res.ok) return { error: 'unavailable' };
      const body = await res.json();
      return { rows: Array.isArray(body) ? body : [] };
    } catch { return { error: 'unavailable' }; }
  }

  // Confirmed, still pending, and the owner hasn't been told yet.
  const toAnnounce = (limit = 5) => rows(
    `signups?confirmed=is.true&notified=is.false&status=eq.pending&select=${FIELDS}&order=created_at.asc&limit=${Number(limit) | 0 || 5}`,
    { method: 'GET', headers: headers() });

  // Every confirmed sign-up still waiting for a decision (for /signups and for finding one by its short id).
  const pending = (limit = 50) => rows(
    `signups?confirmed=is.true&status=eq.pending&select=${FIELDS}&order=created_at.asc&limit=${Number(limit) | 0 || 50}`,
    { method: 'GET', headers: headers() });

  async function markNotified(userId) {
    if (!UUID_RE.test(String(userId))) return { error: 'invalid' };
    const r = await rows(`signups?user_id=eq.${userId}`, { method: 'PATCH', headers: headers('return=representation'), body: JSON.stringify({ notified: true }) });
    return r.error ? r : { ok: true };
  }

  // -> { row } decided just now | { already: true } | { error }
  async function decide(userId, status) {
    if (!UUID_RE.test(String(userId)) || !['approved', 'denied'].includes(status)) return { error: 'invalid' };
    const r = await rows(`signups?user_id=eq.${userId}&status=eq.pending`, {
      method: 'PATCH', headers: headers('return=representation'), body: JSON.stringify({ status, decided_at: now().toISOString() }) });
    if (r.error) return r;
    return r.rows[0] ? { row: r.rows[0] } : { already: true };
  }

  // -> { row: { status, business_name, email } | null } | { error }
  async function get(userId) {
    if (!UUID_RE.test(String(userId))) return { error: 'invalid' };
    const r = await rows(`signups?user_id=eq.${userId}&select=user_id,status,business_name,email&limit=1`, { method: 'GET', headers: headers() });
    return r.error ? r : { row: r.rows[0] || null };
  }

  return { enabled, toAnnounce, pending, markNotified, decide, get };
}
