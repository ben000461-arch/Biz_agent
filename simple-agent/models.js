// models.js — cloud AI models for the heavy jobs (like coding) that a small
// local model can't do on a small computer.
//
// Two ways a business gets one:
//   1. MANAGED — the person running the bot (the admin) adds provider keys once
//      and offers a menu of models. Businesses just pick one with /model; they
//      never see or handle a key. Usage is capped per business and overall.
//   2. THEIR OWN — a business can add its own key (then they pay the provider).
//
// How a key gets in: a private web page with a password box (see server.js).
// It goes straight into the encrypted vault — never through Telegram, never
// through the local AI, so chat history and screenshots can't leak it.
//
// What gets sent out: only what a task needs (the task and one file), and only
// when someone runs /code (and, for managed models, only after that business has
// said yes once).

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', kind: 'anthropic', base: 'https://api.anthropic.com/v1', defaultModel: 'claude-sonnet-5-5' },
  openai: { label: 'OpenAI', kind: 'openai', base: 'https://api.openai.com/v1', defaultModel: '' },
  openrouter: { label: 'OpenRouter', kind: 'openai', base: 'https://openrouter.ai/api/v1', defaultModel: '' },
  groq: { label: 'Groq', kind: 'openai', base: 'https://api.groq.com/openai/v1', defaultModel: '' },
};

const KEY_RE = /^[\x21-\x7E]{16,400}$/; // printable ASCII, no spaces
// Clean up common paste problems (phones add spaces/newlines/quotes; people paste "Bearer xxx" or KEY=xxx).
function cleanKey(raw) {
  let k = String(raw || '').normalize('NFKC');
  k = k.replace(/[^\x21-\x7E]/g, ''); // keys are plain ASCII: drop spaces, newlines and any invisible/unusual characters
  k = k.replace(/^(authorization:?)?(bearer)?/i, '');
  k = k.replace(/^[A-Za-z_]*API_?KEY=/i, '');
  k = k.replace(/^["'`\u2018\u2019\u201C\u201D]+|["'`\u2018\u2019\u201C\u201D]+$/g, '');
  return k;
}
// Describe a rejected key without revealing it.
function keyHint(raw) {
  const k = String(raw || '');
  if (!k.trim()) return 'The key box looks empty.';
  const kept = cleanKey(k).length;
  return `I received ${k.length} characters (${kept} usable). A key is usually 40-100 characters.`;
}
const MODEL_RE = /^[A-Za-z0-9_.\-:/]{1,100}$/;
const LABEL_RE = /^[A-Za-z0-9 ._()+\-]{1,40}$/;
const SETUP_TTL = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const SERVER = 'server'; // the vault "chat" that holds the admin's managed keys

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// An error whose message is safe and useful to show the person as-is.
export class ModelProblem extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.userFacing = true;
    this.code = code;
    Object.assign(this, extra);
  }
}

// Models sometimes wrap JSON in words or code fences.
export function extractJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON in model answer');
  return JSON.parse(s.slice(a, b + 1));
}

export function createModelConnector({
  vault, publicUrl, catalogFile, bases = {},
  dailyLimit = 25, // per business, own key (they pay)
  managedDailyLimit = 10, // per business, shared key (the admin pays)
  managedGlobalLimit = 100, // all businesses together, shared key
  timeoutMs = 180_000,
}) {
  const setups = new Map(); // state -> { chatId, managed, expires, attempts }
  const usage = new Map(); // `${kind}:${chatId}` -> { day, n }
  const globalUse = { day: '', n: 0 };
  const baseFor = (name) => String(bases[name] || PROVIDERS[name].base).replace(/\/$/, '');
  const today = () => new Date().toISOString().slice(0, 10);

  // ---- the menu of managed models (nothing secret in it) ----
  let catalog = [];
  if (catalogFile) {
    try {
      catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8')).models || [];
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Couldn't read ${catalogFile}: ${err.message}`);
    }
  }
  const saveCatalog = () => {
    if (!catalogFile) return;
    fs.mkdirSync(path.dirname(catalogFile), { recursive: true });
    const tmp = `${catalogFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ models: catalog }, null, 2));
    fs.renameSync(tmp, catalogFile);
  };
  const serverKey = (provider) => vault.get(SERVER, `managed:${provider}`)?.apiKey || null;
  const ready = (m) => Boolean(serverKey(m.provider));
  const slug = (label) => {
    const base = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20) || 'model';
    let id = base;
    for (let n = 2; catalog.some((m) => m.id === id) || ['local', 'own'].includes(id); n++) id = `${base}_${n}`;
    return id;
  };

  // One request to a provider. Provider answers are never echoed to the person
  // (they can include fragments of the key); only our own wording is.
  async function ask(rec, { system, user, maxTokens }, { managed = false, allowEmpty = false } = {}) {
    const p = PROVIDERS[rec.provider];
    if (!p) throw new ModelProblem('The saved AI model setting is invalid — send /connect model again.', 'bad-config');
    const call = async (tokenField) => {
      const url = p.kind === 'anthropic' ? `${baseFor(rec.provider)}/messages` : `${baseFor(rec.provider)}/chat/completions`;
      const headers = p.kind === 'anthropic'
        ? { 'x-api-key': rec.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
        : { Authorization: `Bearer ${rec.apiKey}`, 'content-type': 'application/json', 'user-agent': 'biz-agent/1.0', accept: 'application/json' };
      const body = p.kind === 'anthropic'
        ? { model: rec.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }
        : { model: rec.model, [tokenField]: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
      try {
        return await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        throw new ModelProblem(err.name === 'TimeoutError' ? `${p.label} took too long to answer.` : `I couldn't reach ${p.label} just now.`, 'network');
      }
    };
    let res = await call(rec.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens');
    if (res.status === 400 && p.kind === 'openai') {
      // Providers disagree on this field name; if it's the complaint, try the other one once.
      const msg = await res.text().catch(() => '');
      if (/max_completion_tokens|max_tokens/.test(msg)) res = await call(rec.provider === 'openai' ? 'max_tokens' : 'max_completion_tokens');
      else throw new ModelProblem(`${p.label} didn't accept the request (error 400) — check the model name.`, 'bad-request');
    }
    // For the shared key, a business can't fix a rejected key or empty balance —
    // tell them it's not them, and give the admin the real reason to act on.
    const down = (admin) => new ModelProblem("The shared AI service isn't available right now — I've let the person running the bot know. You can use /model_local in the meantime (slower).", 'managed-down', { adminText: admin });
    if (res.status === 401 || res.status === 403) {
      if (managed) throw down(`The shared ${p.label} key was rejected (${res.status}). It may be deleted or expired — add it again with /addmodel.`);
      // Safe detail: status plus the provider's short error code (never the body, which can quote the key).
      const raw = await res.text().catch(() => '');
      let code = '';
      try { const j = JSON.parse(raw); code = String(j?.error?.code || j?.error?.type || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40); } catch { if (/^\s*<|cloudflare/i.test(raw)) code = 'blocked-by-firewall'; }
      throw new ModelProblem(`${p.label} rejected the API key (error ${res.status}${code ? ', ' + code : ''}). It may have been deleted or expired — send /connect model to add a new one.`, 'key-rejected');
    }
    if (res.status === 402) {
      if (managed) throw down(`The shared ${p.label} account says it is out of credit.`);
      throw new ModelProblem(`${p.label} says the account is out of credit.`, 'no-credit');
    }
    if (res.status === 429) throw new ModelProblem(`${p.label} is rate-limiting right now (or the account is out of credit). Try again in a bit.`, 'rate-limit');
    if (res.status === 404) {
      if (managed) throw down(`${p.label} doesn't know the model "${rec.model}" — remove it and add it again with /addmodel.`);
      throw new ModelProblem(`${p.label} doesn't know the model "${rec.model}" — send /connect model and check the name.`, 'bad-model');
    }
    if (!res.ok) throw new ModelProblem(`${p.label} had a problem (error ${res.status}). Try again in a moment.`, 'provider-error');
    const data = await res.json().catch(() => ({}));
    const text = p.kind === 'anthropic'
      ? (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
      : data.choices?.[0]?.message?.content;
    // Thinking models can use a small token budget up silently; for a connection test, a 200 reply is enough.
    if (typeof text !== 'string' || !text.trim()) {
      if (allowEmpty) return '';
      throw new ModelProblem(`${p.label} sent back an empty answer.`, 'empty');
    }
    return text;
  }

  const bump = (key, limit) => {
    const u = usage.get(key);
    const cur = u && u.day === today() ? u : { day: today(), n: 0 };
    if (cur.n >= limit) return false;
    cur.n += 1;
    usage.set(key, cur);
    return true;
  };

  return {
    // ---- the private key page ----
    // managed=true: the admin adding a model + key for everyone to choose from.
    startSetup(chatId, { managed = false } = {}) {
      for (const [s, v] of setups) if (Date.now() > v.expires) setups.delete(s);
      const state = crypto.randomBytes(24).toString('hex');
      setups.set(state, { chatId: String(chatId), managed, expires: Date.now() + SETUP_TTL, attempts: 0 });
      return `${String(publicUrl).replace(/\/$/, '')}/connect/model?state=${state}`;
    },

    isValidSetup(state) {
      const s = setups.get(String(state));
      return Boolean(s && Date.now() <= s.expires && s.attempts < MAX_ATTEMPTS);
    },

    formHtml(state, error = '') {
      const managed = Boolean(setups.get(String(state))?.managed);
      const opts = Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('');
      const intro = managed
        ? `<p>Add a model that <b>every business on this bot can choose from</b>. The key is typed here, stored encrypted on the computer running the bot, and never sent through Telegram or shown to the AI. <b>You pay this provider</b> for what businesses use (each business and the bot overall have daily limits).</p>
<p style="font-size:.9em;color:#555">If you've already added a key for this provider, leave the key box empty to add another model that uses it.</p>`
        : `<p>This lets the bot use a stronger cloud model for coding tasks. <b>Your key is typed here, stored encrypted on the computer running the bot, and never sent through Telegram or shown to the AI.</b></p>
<p style="font-size:.9em;color:#555">When you run <code>/code</code>, the task and the one file being worked on are sent to the provider you pick, and you pay that provider. Create a key with a spending limit if the provider offers one.</p>`;
      return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect an AI model</title>
<body style="font-family:system-ui;max-width:460px;margin:8vh auto;padding:0 20px;line-height:1.45">
<h2>${managed ? 'Add a model for everyone' : 'Connect an AI model'}</h2>
${intro}
${error ? `<p style="color:#b00020"><b>${esc(error)}</b></p>` : ''}
<form method="post" action="/connect/model" autocomplete="off">
<input type="hidden" name="state" value="${esc(state)}">
<p><label>Provider<br><select name="provider" style="width:100%;padding:8px">${opts}</select></label></p>
<p><label>Model name <span style="color:#777">(leave empty for Anthropic's default)</span><br><input name="model" style="width:100%;padding:8px" placeholder="the model's name from your provider" autocomplete="off" spellcheck="false"></label></p>
${managed ? '<p><label>Name businesses will see <span style="color:#777">(e.g. Smart, or Fast)</span><br><input name="label" style="width:100%;padding:8px" maxlength="40" autocomplete="off"></label></p>' : ''}
<p><label>API key<br><input name="key" type="password" style="width:100%;padding:8px" autocomplete="new-password" spellcheck="false"${managed ? '' : ' required'}></label></p>
<p><button type="submit" style="padding:10px 18px">Save</button></p>
</form></body>`;
    },

    // Checks the key with a tiny real request, then stores it encrypted.
    async finishSetup(state, { provider, model, key, label }) {
      const s = setups.get(String(state));
      if (!s || Date.now() > s.expires) throw new ModelProblem('This link expired — send the command again for a new link.', 'expired');
      if (s.attempts >= MAX_ATTEMPTS) { setups.delete(String(state)); throw new ModelProblem('Too many tries on this link — ask for a new one.', 'locked'); }
      s.attempts += 1;
      const p = PROVIDERS[provider];
      if (!p) throw new ModelProblem('Pick a provider from the list.', 'form');
      let apiKey = cleanKey(key);
      if (!apiKey && s.managed) apiKey = serverKey(provider) || ''; // reuse the key already saved for this provider
      if (!KEY_RE.test(apiKey)) throw new ModelProblem(`That doesn't look like an API key. ${keyHint(key)} Try copying it again from the provider page.`, 'form');
      const chosen = String(model || '').trim() || p.defaultModel;
      if (!chosen) throw new ModelProblem(`Type the model name to use with ${p.label}.`, 'form');
      if (!MODEL_RE.test(chosen)) throw new ModelProblem("That model name has characters I don't expect.", 'form');
      const shown = String(label || '').trim();
      if (s.managed && shown && !LABEL_RE.test(shown)) throw new ModelProblem('The name can only use letters, numbers, spaces and . _ ( ) + -', 'form');

      const rec = { provider, apiKey, model: chosen };
      await ask(rec, { system: 'Reply with the single word OK.', user: 'Ping.', maxTokens: 400 }, { allowEmpty: true });
      setups.delete(String(state));

      if (s.managed) {
        vault.set(SERVER, `managed:${provider}`, { apiKey }, { label: p.label });
        const same = catalog.find((m) => m.provider === provider && m.model === chosen);
        const entry = same || { id: slug(shown || `${p.label} ${chosen}`), provider, model: chosen, isDefault: catalog.length === 0 };
        entry.label = shown || same?.label || `${p.label} · ${chosen}`;
        if (!same) catalog.push(entry);
        saveCatalog();
        return { chatId: s.chatId, managed: true, id: entry.id, label: entry.label };
      }
      vault.set(s.chatId, 'model', rec, { label: `${p.label} · ${chosen}` });
      return { chatId: s.chatId, managed: false, label: `${p.label} · ${chosen}` };
    },

    // ---- the managed menu (admin) ----
    models() {
      return catalog.map((m) => ({ ...m, providerLabel: PROVIDERS[m.provider]?.label || m.provider, ready: ready(m) }));
    },
    setDefault(id) {
      if (!catalog.some((m) => m.id === id)) return false;
      for (const m of catalog) m.isDefault = m.id === id;
      saveCatalog();
      return true;
    },
    removeModel(id) {
      const m = catalog.find((x) => x.id === id);
      if (!m) return false;
      catalog = catalog.filter((x) => x.id !== id);
      if (m.isDefault && catalog[0]) catalog[0].isDefault = true;
      // Forget the provider key too once no model uses it any more.
      if (!catalog.some((x) => x.provider === m.provider)) vault.remove(SERVER, `managed:${m.provider}`);
      saveCatalog();
      return true;
    },
    usageToday() {
      return globalUse.day === today() ? globalUse.n : 0;
    },

    // ---- picking and using one ----
    hasOwn: (chatId) => Boolean(vault.get(chatId, 'model')),
    describeOwn(chatId) {
      const r = vault.get(chatId, 'model');
      return r ? { provider: r.provider, providerLabel: PROVIDERS[r.provider]?.label || r.provider, model: r.model } : null;
    },

    // What a business will use for heavy jobs. `choice` is what they picked with
    // /model: 'local', 'own', or a menu id. Nothing picked: their own key if
    // they have one, else the menu's default, else the local model (null).
    // Which cloud model (if any) should do the work?
    // - Their explicit pick (a menu id, or their own key) always wins.
    // - 'local' means local only: never a cloud model, not even as a helper.
    // - Otherwise (automatic) the local model works first, so this returns null —
    //   unless { helper: true } asks for the cloud model that may step in when local can't do the job.
    resolve(chatId, choice, { helper = false } = {}) {
      const own = this.describeOwn(chatId);
      const menu = this.models().filter((m) => m.ready);
      const own_ = own && { kind: 'own', label: `your ${own.providerLabel} key`, providerLabel: own.providerLabel };
      if (choice === 'local') return null;
      if (choice === 'own' && own_) return own_;
      const picked = menu.find((m) => m.id === choice);
      if (picked) return { kind: 'managed', id: picked.id, label: picked.label, providerLabel: picked.providerLabel };
      if (!helper) return null;
      if (own_) return own_;
      const def = menu.find((m) => m.isDefault) || menu[0];
      return def ? { kind: 'managed', id: def.id, label: def.label, providerLabel: def.providerLabel } : null;
    },

    // One coding task = one slot. Stops a loop (or a bug) from running up a bill.
    reserveTask(chatId, sel) {
      const id = String(chatId);
      if (sel.kind === 'own') {
        return bump(`own:${id}`, dailyLimit) ? { ok: true } : { ok: false, why: 'tenant', limit: dailyLimit };
      }
      if (globalUse.day !== today()) { globalUse.day = today(); globalUse.n = 0; }
      if (globalUse.n >= managedGlobalLimit) return { ok: false, why: 'global', limit: managedGlobalLimit };
      if (!bump(`managed:${id}`, managedDailyLimit)) return { ok: false, why: 'tenant', limit: managedDailyLimit };
      globalUse.n += 1;
      return { ok: true };
    },

    async complete(chatId, sel, { system, user, maxTokens = 3000 }) {
      if (sel.kind === 'own') {
        const rec = vault.get(chatId, 'model');
        if (!rec) throw new ModelProblem('No AI model is connected — send /connect model.', 'not-connected');
        return ask(rec, { system, user, maxTokens });
      }
      const m = catalog.find((x) => x.id === sel.id);
      const apiKey = m && serverKey(m.provider);
      if (!m || !apiKey) throw new ModelProblem('That model is no longer offered — pick another with /model.', 'gone');
      return ask({ provider: m.provider, apiKey, model: m.model }, { system, user, maxTokens }, { managed: true });
    },

    // Load a provider key that was put in .env: check it, store it encrypted in the vault,
    // and make sure there is a menu entry for it. Returns a short, key-free status line.
    async importManaged({ provider, apiKey: rawKey, model, label }) {
      const p = PROVIDERS[provider];
      if (!p) return `unknown provider "${provider}"`;
      const apiKey = cleanKey(rawKey);
      if (!KEY_RE.test(apiKey)) return `the key in .env doesn't look right (${apiKey.length} usable characters)`;
      const chosen = String(model || '').trim() || p.defaultModel;
      if (!chosen || !MODEL_RE.test(chosen)) return 'set a valid model name for it in .env';
      const shown = String(label || '').trim();
      if (shown && !LABEL_RE.test(shown)) return 'the model display name has characters I don\'t accept';
      const same = catalog.find((m) => m.provider === provider && m.model === chosen);
      if (same && serverKey(provider) === apiKey) return 'already set up';
      try {
        await ask({ provider, apiKey, model: chosen }, { system: 'Reply with the single word OK.', user: 'Ping.', maxTokens: 400 }, { allowEmpty: true });
      } catch (err) {
        return `${p.label} test failed: ${err.message}`;
      }
      vault.set(SERVER, `managed:${provider}`, { apiKey }, { label: p.label });
      const entry = same || { id: slug(shown || `${p.label} ${chosen}`), provider, model: chosen, isDefault: catalog.length === 0 };
      entry.label = shown || same?.label || `${p.label} · ${chosen}`;
      if (!same) catalog.push(entry);
      saveCatalog();
      return `loaded "${entry.label}" (${p.label} · ${chosen})`;
    },

    disconnectOwn(chatId) {
      return vault.remove(chatId, 'model');
    },
  };
}