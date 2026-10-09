// vault.js — where each business's connection tokens (Gmail, Calendar, ...)
// are kept. Secrets are encrypted with AES-256-GCM using TOKEN_ENCRYPTION_KEY,
// so a copy of connections.json on its own is useless. Only harmless details
// (which provider, which account, when) are stored readable, so a dashboard
// can show "Gmail connected as x@y.com" without ever touching a secret.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export function createVault(file, keyHex) {
  const key = Buffer.from(String(keyHex || ''), 'hex');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex characters (run: openssl rand -hex 32)');

  let state = { connections: {} };
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Couldn't read ${file}: ${err.message}`);
  }
  state.connections ||= {};

  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };

  const encrypt = (obj) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
  };
  const decrypt = (str) => {
    const [iv, tag, enc] = str.split('.').map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString('utf8'));
  };

  return {
    // Returns the secret blob, or null if not connected / can't be decrypted.
    get(chatId, provider) {
      const rec = state.connections[String(chatId)]?.[provider];
      if (!rec) return null;
      try {
        return decrypt(rec.secret);
      } catch {
        return null; // wrong key or tampered file — treat as not connected
      }
    },
    set(chatId, provider, secret, meta = {}) {
      const id = String(chatId);
      state.connections[id] ||= {};
      const prev = state.connections[id][provider];
      state.connections[id][provider] = {
        secret: encrypt(secret),
        email: meta.email ?? prev?.email ?? null,
        label: meta.label ?? prev?.label ?? null,
        connectedAt: prev?.connectedAt || new Date().toISOString(),
      };
      save();
    },
    remove(chatId, provider) {
      const id = String(chatId);
      if (!state.connections[id]?.[provider]) return false;
      delete state.connections[id][provider];
      if (!Object.keys(state.connections[id]).length) delete state.connections[id];
      save();
      return true;
    },
    // Safe-to-show summary (no secrets).
    status(chatId) {
      const conns = state.connections[String(chatId)] || {};
      return Object.entries(conns).map(([provider, r]) => ({ provider, email: r.email, label: r.label, connectedAt: r.connectedAt }));
    },
    removeAll(chatId) {
      if (!state.connections[String(chatId)]) return false;
      delete state.connections[String(chatId)];
      save();
      return true;
    },
  };
}