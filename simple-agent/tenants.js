// tenants.js — the little database behind the shared bot.
//
// One shared Telegram bot serves many businesses. This file is where the bot
// remembers WHO each chat belongs to and what they're allowed to do. It's a
// plain JSON file on purpose (zero dependencies, easy to eyeball, easy for the
// dashboard to read later) — fine for a pilot with a handful of businesses.
// When it outgrows that, the same function names can sit on top of SQLite.
//
// Two things live in the file:
//   tenants — one record per registered chat (a business), keyed by chat ID
//   invites — one-time codes you hand out so a business can sign itself up

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Tool groups a business can have switched on. The server maps every action
// to one of these (see ACTION_GROUP in server.js).
export const ALL_TOOL_GROUPS = ['files', 'email', 'spreadsheets', 'utilities', 'calendar', 'github'];

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // an unused invite expires after 7 days

export function createStore(file) {
  let state = { tenants: {}, invites: {} };

  function load() {
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return; // first run, nothing saved yet
      // A corrupt file must stop the server, not silently start empty and
      // overwrite every business's registration on the next save.
      throw new Error(`Couldn't read ${file}: ${err.message}`);
    }
    state.tenants ||= {};
    state.invites ||= {};
    // Older records predate the "calendar" tool group: switch it on once, then
    // remember we did, so a business that later turns it off stays off.
    let migrated = false;
    for (const rec of Object.values(state.tenants)) {
      const v = rec.schemaVersion || 1;
      if (v < 3) {
        if (v < 2 && !rec.tools.includes('calendar')) rec.tools.push('calendar');
        if (!rec.tools.includes('github')) rec.tools.push('github');
        rec.schemaVersion = 3;
        migrated = true;
      }
    }
    if (migrated) save();
  }

  // Write to a temp file then rename, so a crash mid-write can't leave a
  // half-written (corrupt) tenants file behind.
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
  }

  load();

  return {
    get(chatId) {
      return state.tenants[String(chatId)] || null;
    },

    list() {
      return Object.values(state.tenants);
    },

    // Used for the admin's own record: create it if missing, never overwrite.
    ensure(chatId, fields) {
      const key = String(chatId);
      if (!state.tenants[key]) {
        state.tenants[key] = {
          chatId: key,
          createdAt: new Date().toISOString(),
          tools: [...ALL_TOOL_GROUPS],
          instructions: '',
          isAdmin: false,
          schemaVersion: 3,
          ...fields,
        };
        save();
      }
      return state.tenants[key];
    },

    createInvite(businessName) {
      // Drop expired invites while we're here so the file doesn't pile up.
      for (const [code, inv] of Object.entries(state.invites)) {
        if (Date.now() - inv.createdAt > INVITE_TTL_MS) delete state.invites[code];
      }
      const code = crypto.randomBytes(5).toString('hex'); // 10 chars, fits Telegram's /start limits
      state.invites[code] = { name: businessName, createdAt: Date.now() };
      save();
      return code;
    },

    // Turns an invite code into a registered business. Single use.
    redeemInvite(code, chatId) {
      const key = String(chatId);
      if (state.tenants[key]) return { error: 'already-registered', tenant: state.tenants[key] };

      const invite = state.invites[(code || '').trim()];
      if (!invite) return { error: 'invalid' };
      if (Date.now() - invite.createdAt > INVITE_TTL_MS) {
        delete state.invites[code.trim()];
        save();
        return { error: 'expired' };
      }

      delete state.invites[code.trim()]; // single use
      state.tenants[key] = {
        chatId: key,
        name: invite.name,
        createdAt: new Date().toISOString(),
        tools: [...ALL_TOOL_GROUPS],
        instructions: '',
        isAdmin: false,
        schemaVersion: 3,
      };
      save();
      return { tenant: state.tenants[key] };
    },

    remove(chatId) {
      const key = String(chatId);
      const existing = state.tenants[key];
      if (!existing || existing.isAdmin) return false; // never remove the admin record
      delete state.tenants[key];
      save();
      return true;
    },

    setInstructions(chatId, text) {
      const t = state.tenants[String(chatId)];
      if (!t) return false;
      t.instructions = text;
      save();
      return true;
    },

    // A few small per-business preferences (which AI to use, whether they've
    // agreed to cloud AI seeing their task + one file). Nothing else can be set.
    setPrefs(chatId, patch) {
      const t = state.tenants[String(chatId)];
      if (!t) return false;
      if ('modelChoice' in patch) t.modelChoice = patch.modelChoice === null ? undefined : String(patch.modelChoice).slice(0, 40);
      if ('cloudOk' in patch) t.cloudOk = Boolean(patch.cloudOk);
      save();
      return true;
    },

    setTools(chatId, groups) {
      const t = state.tenants[String(chatId)];
      if (!t) return false;
      t.tools = groups;
      save();
      return true;
    },
  };
}