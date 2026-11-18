// "Delete my account and data": the Supabase side.
//
// What is removed for one business (one Telegram chat):
//   web_chat_messages, agent_logs, tool_connections (encrypted tool tokens), tool_requests,
//   and every website login tied to the chat (the auth user; signups, link_codes and tenant_users
//   go with it because they reference auth.users "on delete cascade").
// What is kept, on purpose:
//   tenant_plans, credit_ledger, billing_accounts, stripe_events: payment records we may need for accounting,
//   and so a deleted account can't restart a free trial. They hold no message text.
// The local side (agents, notes, files, saved Google/GitHub/AI-key access) is cleaned up by the caller in server.js.
//
// A business with a live paid plan is stopped first: they cancel in the billing portal, then delete.

const CHAT_RE = /^-?\d{1,20}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DELETED_TABLES = ['web_chat_messages', 'agent_logs', 'tool_connections', 'tool_requests'];
const LIVE_PLAN = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete']);

export function createAccounts({ url, key, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const base = String(url || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  const secret = String(key || '').trim();
  const enabled = Boolean(base && secret);

  const headers = (prefer) => {
    const h = { 'content-type': 'application/json', apikey: secret };
    if (secret.startsWith('eyJ')) h.authorization = `Bearer ${secret}`;
    if (prefer) h.Prefer = prefer;
    return h;
  };
  const call = async (path, opts) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try { return await fetchImpl(`${base}${path}`, { ...opts, signal: ctl.signal }); } finally { clearTimeout(timer); }
  };

  // -> { blocked: 'paid_plan' } when a paid plan is still running, {} otherwise, { error } if we can't tell
  async function check(chatId) {
    if (!enabled) return { error: 'unavailable' };
    if (!CHAT_RE.test(String(chatId))) return { error: 'bad chat' };
    try {
      const res = await call(`/rest/v1/billing_accounts?chat_id=eq.${encodeURIComponent(String(chatId))}&select=status,cancel_at_end&limit=1`, { method: 'GET', headers: headers() });
      if (res.status === 404) return {}; // no billing table at all: nothing to stop
      if (!res.ok) return { error: 'unavailable' };
      const [row] = await res.json();
      if (row && LIVE_PLAN.has(String(row.status)) && !row.cancel_at_end) return { blocked: 'paid_plan' };
      return {};
    } catch { return { error: 'unavailable' }; }
  }

  // -> { ok: true, removed: {table: n}, logins: n, failed: [names] }
  async function remove(chatId) {
    if (!enabled) return { error: 'unavailable' };
    const id = String(chatId);
    if (!CHAT_RE.test(id)) return { error: 'bad chat' };
    const removed = {};
    const failed = [];
    // which website logins belong to this chat (read before anything is deleted)
    let userIds = [];
    try {
      const res = await call(`/rest/v1/tenant_users?chat_id=eq.${encodeURIComponent(id)}&select=user_id`, { method: 'GET', headers: headers() });
      if (res.ok) userIds = (await res.json()).map((r) => String(r.user_id)).filter((u) => UUID_RE.test(u));
      else failed.push('tenant_users');
    } catch { failed.push('tenant_users'); }
    // tool_connections first: it points at tool_requests
    for (const table of DELETED_TABLES) {
      try {
        const res = await call(`/rest/v1/${table}?chat_id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: headers('return=representation') });
        if (res.status === 404) { removed[table] = 0; continue; } // that table isn't set up: nothing to delete
        if (!res.ok) { failed.push(table); continue; }
        const rows = await res.json().catch(() => []);
        removed[table] = Array.isArray(rows) ? rows.length : 0;
      } catch { failed.push(table); }
    }
    // the logins themselves (signups, link_codes and tenant_users go with them)
    let logins = 0;
    for (const uid of userIds) {
      try {
        const res = await call(`/auth/v1/admin/users/${uid}`, { method: 'DELETE', headers: headers() });
        if (res.ok || res.status === 404) logins++;
        else failed.push('login');
      } catch { failed.push('login'); }
    }
    // if a login couldn't be deleted, at least cut its link to this chat
    if (failed.includes('login') || failed.includes('tenant_users')) {
      try {
        const res = await call(`/rest/v1/tenant_users?chat_id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', headers: headers('return=minimal') });
        if (!res.ok) failed.push('unlink');
      } catch { failed.push('unlink'); }
    }
    return { ok: failed.length === 0, removed, logins, failed: [...new Set(failed)] };
  }

  return { enabled, check, remove };
}
