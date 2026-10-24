// apply-phase2b.mjs — one-time edit of server.js that adds the credit meter. Run AFTER apply-phase2.mjs.
// Same safety rules: backup first (server.js.bak-phase2b), every edit must match exactly once or nothing
// is written, refuses to run twice.   Run from the simple-agent folder:   node apply-phase2b.mjs
import fs from 'node:fs';

const file = process.argv[2] || 'server.js';
let src = fs.readFileSync(file, 'utf8');
if (!src.includes('handleMessageInner')) { console.log('Run apply-phase2.mjs first. Nothing changed.'); process.exit(1); }
if (src.includes('createMeter')) { console.log('Already applied. Nothing changed.'); process.exit(0); }

const problems = [];
const once = (label, find, replace) => {
  const n = src.split(find).length - 1;
  if (n !== 1) { problems.push(`${label}: expected 1 match, found ${n}`); return; }
  src = src.replace(find, () => replace);
};

// 1. imports
once('imports', "import { createEntitlements, frozenMessage, trialReminderMessage } from './entitlement.js';\n",
`import { createEntitlements, frozenMessage, trialReminderMessage } from './entitlement.js';
import { createMeter, decide, crossing, nextReset, blockMessage, warningMessage, usageMessage, rateLimitMessage, actionCosts } from './meter.js';
import { PLANS as PLAN_TABLE, SETTABLE_PLANS, creditCost } from './plans.js';
`);

// 2. the meter + the "settle up after an action" helper
once('meter setup', "const entitlements = createEntitlements({ url: SUPABASE_URL, key: SUPABASE_SERVICE_KEY });\n",
`const entitlements = createEntitlements({ url: SUPABASE_URL, key: SUPABASE_SERVICE_KEY });
const meter = createMeter({ url: SUPABASE_URL, key: SUPABASE_SERVICE_KEY });
console.log(\`Credit meter: \${meter.enabled ? 'on' : 'OFF (no Supabase settings: credit plans run on small limits)'}.\`);
// After an action or chat succeeds: count it, charge the credits for the model that REALLY answered, and
// return a warning line if this spend crossed 80% or 100% of the month's credits.
async function settle(ctx, tenant, action, kind) {
  try {
    meter.bump(tenant.chatId, kind);
    const rc = [...(ctx.receipts || [])].reverse().find((r) => kind !== 'chat' || r.role === 'chat');
    const cost = kind === 'chat' ? (rc ? creditCost('chat', rc.tier) : 0) : creditCost('action');
    if (!cost) return null;
    const r = await meter.charge(tenant.chatId, ctx.ent, cost, { action, model: rc?.model || null });
    const level = r.after != null ? crossing(r.before, r.after, r.total) : null;
    return level ? warningMessage(level, { left: r.left }, { reset: nextReset(ctx.ent.anchor, ctx.ent.cycleStart) }) : null;
  } catch (err) {
    console.warn('[meter] settle failed:', err.message);
    return null;
  }
}
`);

// 3. runAction: check the meter before, charge after
once('runAction', `async function runAction(tenant, action, args) {
  const t0 = Date.now();
  try {
    const result = await executeAction(tenant, action, args);
    logEvent(tenant, { kind: action === 'chat' ? 'chat' : 'action', action, status: 'done', detail: detailOf(args), ms: Date.now() - t0 });
    return result;`,
`async function runAction(tenant, action, args) {
  const t0 = Date.now();
  const ctx = als.getStore();
  const kind = action === 'chat' ? 'chat' : 'action';
  const gated = entitlements.enabled && Boolean(ctx?.ent?.plan) && (kind === 'chat' || actionCosts(action)); // no Supabase settings = legacy mode, unmetered
  try {
    if (gated) {
      const st = await meter.state(tenant.chatId, ctx.ent);
      const d = decide(ctx.ent.plan, kind, st, meter.counts(tenant.chatId));
      ctx.tierOverride = d.ok ? d.tierOverride || null : null; // out of credits: chat drops to the free small model
      if (!d.ok) {
        logEvent(tenant, { kind: 'blocked', action, status: 'blocked', reason: d.reason });
        return { text: blockMessage(d.reason, { reset: nextReset(ctx.ent.anchor, ctx.ent.cycleStart) }) };
      }
    }
    const result = await executeAction(tenant, action, args);
    logEvent(tenant, { kind: action === 'chat' ? 'chat' : 'action', action, status: 'done', detail: detailOf(args), ms: Date.now() - t0 });
    if (gated) {
      const warn = await settle(ctx, tenant, action, kind);
      if (warn && result && typeof result === 'object') result.followUp = warn; // sent right after the answer
    }
    return result;`);

// 4. chat calls honour the meter's cheap-tier override
once('tier override', "system: systemPrompt, user: userText, history, temperature, json: true,",
  "system: systemPrompt, user: userText, history, temperature, json: true,\n      ...(role === 'chat' && ctx?.tierOverride ? { tierOverride: ctx.tierOverride } : {}),");

// 5. the warning goes out after the answer
once('deliver', "  if (result.file && (!tenant.isAdmin || result.sendFile)) await sendTelegramDocument(chatId, result.file);\n}",
  "  if (result.file && (!tenant.isAdmin || result.sendFile)) await sendTelegramDocument(chatId, result.file);\n  if (result.followUp) await sendTelegramMessage(chatId, result.followUp);\n}");

// 6. per-minute limit at the front door (after the paused check, before reminders)
once('rate limit', "  const due = entitlements.reminderDue(ent);",
`  const rl = entitlements.enabled ? meter.allowMessage(tenant.chatId, ent.plan?.perMinute) : { ok: true };
  if (!rl.ok) { if (rl.notify) await sendTelegramMessage(chatId, rateLimitMessage()); return; }
  const due = entitlements.reminderDue(ent);`);

// 7. commands: /usage for everyone, /plan and /topup for you
once('adminOnly', "const adminOnly = new Set(['/invite', '/businesses', '/remove', '/tools', '/addmodel', '/models', '/signups']);",
  "const adminOnly = new Set(['/invite', '/businesses', '/remove', '/tools', '/addmodel', '/models', '/signups', '/plan', '/topup']);");
once('commands', "    case '/businesses': {",
`    case '/usage': {
      if (!tenant) { await sendTelegramMessage(chatId, INVITE_ONLY_MSG); return true; }
      const e = await entitlements.get(tenant);
      const st = await meter.state(tenant.chatId, e);
      await sendTelegramMessage(chatId, e.canUse ? usageMessage(e, st, { reset: nextReset(e.anchor, e.cycleStart) }) : frozenMessage(e, { siteUrl: String(SITE_URL).replace(/\\/?$/, '/') }));
      return true;
    }

    case '/plan': {
      const [target, planName, daysRaw] = arg.split(/\\s+/).filter(Boolean);
      const rec = /^-?\\d{1,20}$/.test(target || '') ? store.get(target) : null;
      const usage = \`Usage: /plan <chat id> [plan] [days]. Plans: \${SETTABLE_PLANS.join(', ')}. Find chat ids with /businesses. Without a plan it just shows what they are on.\`;
      if (!rec || rec.isAdmin) { await sendTelegramMessage(chatId, usage); return true; }
      if (!planName) {
        const e = await entitlements.get(rec);
        const st = await meter.state(rec.chatId, e);
        await sendTelegramMessage(chatId, \`\${rec.name}: \${e.plan?.label || 'paused'} (\${e.state}\${e.reason ? \`, \${e.reason}\` : ''}). \${usageMessage(e, st, { reset: nextReset(e.anchor, e.cycleStart) })}\`);
        return true;
      }
      if (!SETTABLE_PLANS.includes(planName)) { await sendTelegramMessage(chatId, \`I don't know the plan "\${planName}". \${usage}\`); return true; }
      let days = daysRaw == null ? null : Number(daysRaw);
      if (daysRaw != null && !(Number.isInteger(days) && days > 0 && days <= 366)) { await sendTelegramMessage(chatId, 'Days must be a whole number from 1 to 366.'); return true; }
      if (days == null && ['trial', 'starter', 'pro', 'business'].includes(planName)) days = 30; // billed by hand for now: renew with /plan
      const endsAt = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
      const res = await entitlements.setPlan(rec.chatId, { plan: planName, endsAt, anchor: new Date().toISOString().slice(0, 10) });
      meter.invalidate(rec.chatId);
      await sendTelegramMessage(chatId, res.ok
        ? \`\${rec.name} is now on \${PLAN_TABLE[planName]?.label || 'Paused'}\${days ? \` for \${days} days (until \${endsAt.slice(0, 10)})\` : ' with no end date'}. Their credit cycle starts today.\`
        : \`I couldn't change the plan (\${res.error}). Nothing was changed.\`);
      return true;
    }

    case '/topup': {
      const target = arg.split(/\\s+/)[0];
      const rec = /^-?\\d{1,20}$/.test(target || '') ? store.get(target) : null;
      if (!rec || rec.isAdmin) { await sendTelegramMessage(chatId, 'Usage: /topup <chat id>. It adds one top-up pack to that business for this billing cycle. Find chat ids with /businesses.'); return true; }
      const e = await entitlements.get(rec);
      const r = await meter.topup(rec.chatId, e);
      await sendTelegramMessage(chatId, r.ok ? \`Added \${r.credits} credits to \${rec.name}. They expire when the billing cycle resets.\`
        : r.error === 'limit' ? \`\${rec.name} has already used every top-up their plan allows this cycle.\`
        : r.error === 'no-credits' ? \`\${rec.name}'s plan isn't measured in credits, so there is nothing to top up.\`
        : "I couldn't reach the credit ledger, so nothing was added. Try again in a minute.");
      return true;
    }

    case '/businesses': {`);

if (problems.length) {
  console.log('Nothing was changed. These edits did not match your server.js:');
  for (const p of problems) console.log('  - ' + p);
  console.log('Send me this list and the lines around each spot.');
  process.exit(1);
}
fs.copyFileSync(file, `${file}.bak-phase2b`);
fs.writeFileSync(file, src);
console.log(`Done. Saved your old file as ${file}.bak-phase2b (restore with: cp ${file}.bak-phase2b ${file}).`);
