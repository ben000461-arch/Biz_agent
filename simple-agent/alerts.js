// Problems the owner (admin) should hear about, sent to the admin's Telegram.
//
// alert(key, text): the same key is sent at most once per `perKeyMs` (default 1 hour), and no more than
// `maxPerHour` alerts go out in total; after that one "too many alerts" note is sent and the rest wait.
// Callers pass short, code-written text (a business name, a chat id, an error NAME). Nothing a customer typed,
// no token and no key is ever put in an alert; redact() is a last line of defence for error messages.

const SECRETISH = /\b(gsk_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9_-]{10,}|sk_(live|test)_[A-Za-z0-9]{6,}|sb_secret_[A-Za-z0-9_-]{6,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|AIza[0-9A-Za-z_-]{10,}|ya29\.[A-Za-z0-9._-]+|1\/\/[A-Za-z0-9._-]{10,}|eyJ[A-Za-z0-9._-]{20,}|\d{8,10}:[A-Za-z0-9_-]{30,}|whsec_[A-Za-z0-9]{6,})\b/g;

export function redact(text, max = 300) {
  return String(text ?? '').replace(SECRETISH, '[hidden]').replace(/[\x00-\x08\x0b-\x1f]+/g, ' ').slice(0, max);
}

export function createAlerts({ send, adminId, now = () => Date.now(), perKeyMs = 60 * 60 * 1000, maxPerHour = 10, log = console.warn } = {}) {
  const lastByKey = new Map();
  let sentTimes = [];
  let floodNoted = 0;
  const enabled = Boolean(adminId && typeof send === 'function');

  function alert(key, text) {
    const t = now();
    const k = String(key || 'general');
    log(`[alert] ${k}`); // the server log only gets the key, never the text
    if (!enabled) return false;
    if (lastByKey.has(k) && t - lastByKey.get(k) < perKeyMs) return false;
    sentTimes = sentTimes.filter((x) => t - x < 60 * 60 * 1000);
    if (sentTimes.length >= maxPerHour) {
      if (t - floodNoted > 60 * 60 * 1000) {
        floodNoted = t;
        Promise.resolve().then(() => send(adminId, `⚠️ Too many alerts this hour. I'll hold the rest for a while — check the bot's log.`)).catch(() => {});
      }
      return false;
    }
    lastByKey.set(k, t);
    sentTimes.push(t);
    if (lastByKey.size > 500) for (const [kk, v] of lastByKey) { if (t - v > perKeyMs) lastByKey.delete(kk); }
    Promise.resolve().then(() => send(adminId, `⚠️ ${redact(text, 600)}`)).catch(() => {});
    return true;
  }

  return { alert, enabled };
}
