// Notes each business asks the agent to keep ("note that the Hendersons want a quote Friday").
// Saved on disk so they survive a restart (they used to live only in memory and vanished on every restart,
// even though the agent said "saved"). One JSON file for all businesses, keyed by chat id, written atomically
// (temp file + rename) so a crash mid-write can't corrupt it, and readable only by the bot's user (0600).

import fs from 'fs';
import path from 'path';

const MAX_PER_BUSINESS = 500;   // oldest are dropped past this
const MAX_CHARS = 2000;         // per note

export function createNotes(file) {
  let data = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) data = raw;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // unreadable file: keep a copy aside instead of overwriting it, and start empty
      try { fs.copyFileSync(file, `${file}.unreadable-${Date.now()}`); } catch { /* ignore */ }
      console.error('[notes] notes file could not be read; a copy was kept and a new one started.');
    }
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  const key = (chatId) => String(chatId);

  return {
    list(chatId) {
      const arr = data[key(chatId)];
      return Array.isArray(arr) ? arr.map((n) => ({ text: String(n.text || ''), at: n.at })) : [];
    },
    // returns the new count
    add(chatId, text) {
      const k = key(chatId);
      const arr = Array.isArray(data[k]) ? data[k] : [];
      arr.push({ text: String(text ?? '').slice(0, MAX_CHARS), at: new Date().toISOString() });
      data[k] = arr.slice(-MAX_PER_BUSINESS);
      save();
      return data[k].length;
    },
    remove(chatId) {
      const k = key(chatId);
      if (!(k in data)) return false;
      delete data[k];
      save();
      return true;
    },
  };
}
