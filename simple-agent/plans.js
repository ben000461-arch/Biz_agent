// plans.js — the ONE place that says what each plan gets and what things cost.
//
// Change a price, a credit amount or a cap here and nothing else needs touching. No secrets and no
// network in this file: it is plain data plus a few small helper functions, so it is easy to test.
//
// "Tiers" are logical model sizes. llm.js (next step) maps them to real model names from settings:
//   small = the 8B hosted model   large = the 70B hosted model   local = the 3B on your own computer
//
// NOTE: every price and cost here is a PLACEHOLDER from the pricing talk (Oct 22). Real numbers come from
// the pilot. Keep them in this file so changing them is a one-line edit.

export const TIERS = ['small', 'large', 'local'];

// What things cost in credits. Chat cost depends on which tier actually answered.
export const CREDIT_COSTS = {
  action: 5,                                   // any action (draft, calendar read, spreadsheet, code task...)
  chat: { small: 0, large: 2, local: 0 },      // 8B chat is free (fair use); 70B chat costs 2; fallback 3B is free
};

export const TRIAL_DAYS = 30;
export const PAID_GRACE_DAYS = 3;              // a paid plan whose period ended is still served this long
export const DAILY_FRACTION = 0.25;            // a plan may spend at most 25% of its monthly credits in one day
export const WARN_AT = [0.8, 1.0];             // yellow at 80%, red at 100%
export const TRIAL_REMINDER_DAYS = [25, 28, 30]; // days since the trial began when the bot nudges the owner

export const TOPUP = { priceUsd: 10, credits: 500 }; // expires at the end of the billing cycle

// How long a frozen account's data is kept (shown on the privacy page, enforced by a later cleanup job).
export const RETENTION = { disconnectTokensAfterDays: 30, deleteDataAfterDays: 90 };

// models.router  = decides which action a message asks for
// models.writer  = writes the content (drafts, spreadsheet rows, code)
// models.chat    = plain conversation
// models.fallback= tiers to try, in order, when the first choice is down
export const PLANS = {
  trial: {
    label: 'Free trial', priceUsd: 0, credits: null,
    models: { router: 'small', writer: 'large', chat: 'large', fallback: ['small', 'local'] },
    daily: { actions: 20, chats: 100 }, topups: 0, perMinute: 10,
  },
  starter: {
    label: 'Starter', priceUsd: 19, credits: 1000,
    models: { router: 'small', writer: 'small', chat: 'small', fallback: ['local'] },
    daily: { chats: 300 }, topups: 2, perMinute: 10,   // chat is free on the 8B, so it gets a fair-use ceiling instead of credits
  },
  pro: {
    label: 'Pro', priceUsd: 49, credits: 3500,
    models: { router: 'small', writer: 'large', chat: 'large', fallback: ['small', 'local'] },
    daily: {}, topups: 2, perMinute: 15,
  },
  business: {
    label: 'Business', priceUsd: 99, credits: 9000,
    models: { router: 'small', writer: 'large', chat: 'large', fallback: ['small', 'local'] },
    daily: {}, topups: 5, perMinute: 20,
  },
  // Hand-picked early customers (your friend). Pro-level, no expiry unless you set one, switched by hand.
  pilot: {
    label: 'Pilot', priceUsd: 0, credits: 3500,
    models: { router: 'small', writer: 'large', chat: 'large', fallback: ['small', 'local'] },
    daily: {}, topups: 0, perMinute: 15,
  },
};

// The public (signed-out) chat on the website. No tools, no private data, no memory.
export const PUBLIC = {
  label: 'Public visitor', credits: null,
  models: { router: 'small', writer: 'small', chat: 'small', fallback: ['local'] },
  perMinute: 6, maxChars: 500, maxOutputTokens: 300, tools: false, memory: false,
};

// Used for the owner's own account: every model, no caps, no credits counted.
export const ADMIN = {
  label: 'Admin', credits: null,
  models: { router: 'small', writer: 'large', chat: 'large', fallback: ['small', 'local'] },
  daily: {}, topups: 0, perMinute: 60,
};

// Used when the plan can't be looked up and nothing is cached: cheap models only, to protect your bill.
export const SAFE_MODE = {
  label: 'Limited mode', credits: null,
  models: { router: 'small', writer: 'small', chat: 'small', fallback: ['local'] },
  daily: { chats: 50, actions: 10 }, topups: 0, perMinute: 6,
};

export const PLAN_KEYS = Object.keys(PLANS);                    // plans a customer can be on
export const SETTABLE_PLANS = [...PLAN_KEYS, 'frozen'];         // values allowed in the database column

export const isPaidPlan = (key) => ['starter', 'pro', 'business'].includes(key);

// Most credits a plan may spend in one day.
export function dailyCreditCeiling(plan) {
  if (!plan || plan.credits == null) return null;
  return Math.floor(plan.credits * DAILY_FRACTION);
}

// How many credits one event costs. tier = the tier that really answered; kind = 'action' | 'chat'.
// A failed, blocked or "I need more detail" reply costs nothing; the caller passes ok=false.
export function creditCost(kind, tier, { ok = true } = {}) {
  if (!ok) return 0;
  if (kind === 'action') return CREDIT_COSTS.action;
  if (kind === 'chat') return CREDIT_COSTS.chat[tier] ?? 0;
  return 0;
}

// Is another top-up allowed this cycle?
export function topupAllowed(plan, topupsThisCycle) {
  return Boolean(plan) && Number(topupsThisCycle) < (plan.topups || 0);
}

// Which tier should answer, given what's left? Out of credits on a credit-metered plan drops to the free 8B.
export function chatTierFor(plan, creditsLeft) {
  const wanted = plan.models.chat;
  if (plan.credits == null) return wanted;
  if (creditCost('chat', wanted) > 0 && creditsLeft < creditCost('chat', wanted)) return 'small';
  return wanted;
}

// The traffic-light state of a usage bar. used/limit are credits.
export function usageLevel(used, limit) {
  if (!limit || limit <= 0) return 'blue';
  const r = used / limit;
  if (r >= WARN_AT[1]) return 'red';
  if (r >= WARN_AT[0]) return 'yellow';
  if (r >= 0.5) return 'green';
  return 'blue';
}

// The billing cycle is monthly, starting on the day-of-month the anchor date has (clamped to short months).
// Returns the start of the cycle that contains `now` as 'YYYY-MM-DD' (UTC dates, so everyone agrees).
export function cycleStart(anchor, now = new Date()) {
  const a = new Date(`${String(anchor).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a.getTime())) return null;
  const day = a.getUTCDate();
  const n = new Date(now);
  const pick = (y, m) => {
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(day, last)));
  };
  let start = pick(n.getUTCFullYear(), n.getUTCMonth());
  if (start.getTime() > n.getTime()) start = pick(n.getUTCFullYear(), n.getUTCMonth() - 1);
  if (start.getTime() < a.getTime()) start = a; // never before the anchor itself
  return start.toISOString().slice(0, 10);
}

// Sanity check used by the tests (and cheap enough to run at startup): catches typos in the table above.
export function validatePlans() {
  const problems = [];
  const all = { ...PLANS, public: PUBLIC, admin: ADMIN, safe: SAFE_MODE };
  for (const [key, p] of Object.entries(all)) {
    const m = p.models || {};
    for (const role of ['router', 'writer', 'chat']) if (!TIERS.includes(m[role])) problems.push(`${key}: models.${role} is not a known tier`);
    if (!Array.isArray(m.fallback) || m.fallback.some((t) => !TIERS.includes(t))) problems.push(`${key}: bad fallback list`);
    if (p.credits != null && !(Number.isInteger(p.credits) && p.credits > 0)) problems.push(`${key}: credits must be a positive whole number or null`);
    if (!(p.perMinute > 0)) problems.push(`${key}: perMinute missing`);
  }
  for (const k of PLAN_KEYS) {
    const p = PLANS[k];
    if (p.credits != null) {
      const c = dailyCreditCeiling(p);
      if (c < CREDIT_COSTS.action) problems.push(`${k}: daily credit ceiling is below the cost of one action`);
    }
  }
  return problems;
}
