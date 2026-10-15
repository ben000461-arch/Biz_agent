// Action log. Records WHAT the agent did, never what anyone said.
//
// Rows go to a Supabase table over its REST API (no extra packages). The log
// is best-effort: if Supabase is off, slow or unreachable the bot carries on,
// and failed rows are retried on the next write (the newest 200 are kept in
// memory). Nothing here ever throws into the caller.
//
// Only a fixed set of short fields is accepted, so message text, email bodies
// and file contents cannot reach the table even by mistake.

const FIELDS = ['chat_id', 'business', 'kind', 'action', 'status', 'detail', 'proposed', 'reason'];
const MAX_LEN = 120;

const tidy = (v) => String(v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_LEN);

export function createLogger({ url, key, fetchImpl = globalThis.fetch, timeoutMs = 5000, maxBuffer = 200 } = {}) {
  // Accept the project URL with or without the "/rest/v1" tail that the dashboard's Data API page shows.
  const base = String(url || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  const secret = String(key || '').trim();
  const enabled = Boolean(base && secret);

  const headers = { 'content-type': 'application/json', apikey: secret, Prefer: 'return=minimal' };
  // Old-style keys are JWTs and go in Authorization too; the newer "secret" keys must not.
  if (secret.startsWith('eyJ')) headers.authorization = `Bearer ${secret}`;

  let buffer = [];
  let flushing = null;
  let lastError = null;

  function clean(row) {
    const out = {};
    for (const f of FIELDS) {
      const v = row?.[f];
      if (v === undefined || v === null || v === '') continue;
      out[f] = tidy(v);
    }
    if (Number.isFinite(row?.ms)) out.ms = Math.max(0, Math.round(row.ms));
    return out;
  }

  async function post(rows) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}/rest/v1/agent_logs`, { method: 'POST', headers, body: JSON.stringify(rows), signal: ctl.signal });
      if (!res.ok) throw new Error(`log write failed (${res.status})`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function flush() {
    if (!enabled) return;
    if (flushing) return flushing; // one write at a time; the next log call will pick up the rest
    flushing = (async () => {
      while (buffer.length) {
        const batch = buffer;
        buffer = [];
        try {
          await post(batch);
          lastError = null;
        } catch (err) {
          lastError = err.name === 'AbortError' ? 'log write timed out' : err.message;
          buffer = batch.concat(buffer).slice(-maxBuffer); // keep them for next time
          break;
        }
      }
    })().finally(() => { flushing = null; });
    return flushing;
  }

  function log(row) {
    if (!enabled) return;
    try {
      const c = clean(row);
      if (!c.chat_id || !c.kind) return;
      buffer.push(c);
      if (buffer.length > maxBuffer) buffer = buffer.slice(-maxBuffer);
      flush().catch(() => {});
    } catch { /* never break the bot over a log line */ }
  }

  return { enabled, log, flush, pending: () => buffer.length, lastError: () => lastError };
}