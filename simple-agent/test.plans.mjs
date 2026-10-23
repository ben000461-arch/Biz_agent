// plans.js unit tests. Not shipped.
import {
  PLANS, PUBLIC, ADMIN, SAFE_MODE, CREDIT_COSTS, TOPUP, validatePlans, dailyCreditCeiling, creditCost, topupAllowed, chatTierFor, usageLevel, cycleStart,
} from './plans.js';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

ok(validatePlans().length === 0, `plan table has no typos: ${validatePlans().join('; ')}`);

// the locked numbers (change these on purpose, not by accident)
ok(PLANS.starter.priceUsd === 19 && PLANS.starter.credits === 1000, 'Starter is $19 with 1,000 credits');
ok(PLANS.pro.priceUsd === 49 && PLANS.pro.credits === 3500, 'Pro is $49 with 3,500 credits');
ok(PLANS.business.priceUsd === 99 && PLANS.business.credits === 9000, 'Business is $99 with 9,000 credits');
ok(TOPUP.priceUsd === 10 && TOPUP.credits === 500, 'a top-up is $10 for 500 credits');
ok(PLANS.starter.topups === 2 && PLANS.pro.topups === 2 && PLANS.business.topups === 5, 'top-ups per cycle are 2 / 2 / 5');
ok(PLANS.trial.daily.actions === 20 && PLANS.trial.daily.chats === 100, 'trial is capped at 20 actions and 100 chats a day');

// models per plan
ok(PLANS.starter.models.writer === 'small' && PLANS.starter.models.chat === 'small', 'Starter writes and chats on the 8B');
for (const k of ['trial', 'pro', 'business', 'pilot']) ok(PLANS[k].models.writer === 'large' && PLANS[k].models.chat === 'large', `${k} uses the 70B for writing and chat`);
for (const [k, p] of Object.entries({ ...PLANS, public: PUBLIC, admin: ADMIN, safe: SAFE_MODE })) {
  ok(p.models.router === 'small', `${k}: the router is always the small model`);
  ok(p.models.fallback.at(-1) === 'local', `${k}: the 3B is the last fallback`);
}
ok(!PUBLIC.models.fallback.includes('large') && PUBLIC.models.chat === 'small', 'public visitors can never reach the 70B');
ok(PUBLIC.tools === false && PUBLIC.memory === false, 'public chat has no tools and no memory');
ok(SAFE_MODE.models.writer === 'small', 'limited mode never uses the 70B');

// credits
ok(creditCost('action', 'small') === 5 && creditCost('action', 'large') === 5, 'an action costs 5 credits on either model');
ok(creditCost('chat', 'small') === 0, '8B chat is free');
ok(creditCost('chat', 'large') === 2, '70B chat costs 2');
ok(creditCost('chat', 'local') === 0, '3B fallback chat is free');
ok(creditCost('action', 'large', { ok: false }) === 0 && creditCost('chat', 'large', { ok: false }) === 0, 'failed, blocked or unclear replies are free');
ok(creditCost('whatever', 'large') === 0, 'unknown event kinds cost nothing');
ok(CREDIT_COSTS.action === 5, 'cost table matches');

// daily ceilings are 25% of monthly
ok(dailyCreditCeiling(PLANS.starter) === 250 && dailyCreditCeiling(PLANS.pro) === 875 && dailyCreditCeiling(PLANS.business) === 2250, 'daily ceilings are 250 / 875 / 2250');
ok(dailyCreditCeiling(PLANS.trial) === null && dailyCreditCeiling(ADMIN) === null, 'trial and admin have no credit ceiling');

// top-ups
ok(topupAllowed(PLANS.pro, 0) && topupAllowed(PLANS.pro, 1) && !topupAllowed(PLANS.pro, 2), 'Pro gets 2 top-ups');
ok(topupAllowed(PLANS.business, 4) && !topupAllowed(PLANS.business, 5), 'Business gets 5 top-ups');
ok(!topupAllowed(PLANS.trial, 0) && !topupAllowed(PLANS.pilot, 0), 'trial and pilot get none');
ok(!topupAllowed(null, 0), 'no plan, no top-up');
// the upgrade really is the better deal once top-ups run out (price per credit)
const starterTopupPerCredit = TOPUP.priceUsd / TOPUP.credits;
ok(starterTopupPerCredit > PLANS.pro.priceUsd / PLANS.pro.credits && starterTopupPerCredit > PLANS.business.priceUsd / PLANS.business.credits, 'top-up credits cost more than plan credits');
ok(PLANS.pro.priceUsd + PLANS.pro.topups * TOPUP.priceUsd < PLANS.business.priceUsd, 'maxed-out Pro still costs less than Business');

// out of credits on a metered 70B plan: chat drops to the free 8B
ok(chatTierFor(PLANS.pro, 100) === 'large', 'enough credits: stay on the 70B');
ok(chatTierFor(PLANS.pro, 1) === 'small', 'one credit left (a 70B chat costs 2): drop to the 8B');
ok(chatTierFor(PLANS.pro, 0) === 'small', 'no credits: drop to the 8B');
ok(chatTierFor(PLANS.starter, 0) === 'small', 'Starter chat is free so it never drops');
ok(chatTierFor(PLANS.trial, 0) === 'large' && chatTierFor(ADMIN, 0) === 'large', 'plans without credits keep their model');

// traffic light
ok(usageLevel(0, 1000) === 'blue' && usageLevel(499, 1000) === 'blue', 'under half is blue');
ok(usageLevel(500, 1000) === 'green' && usageLevel(799, 1000) === 'green', '50-79% is green');
ok(usageLevel(800, 1000) === 'yellow' && usageLevel(999, 1000) === 'yellow', '80%+ is yellow');
ok(usageLevel(1000, 1000) === 'red' && usageLevel(1500, 1000) === 'red', 'used up is red');
ok(usageLevel(5, 0) === 'blue', 'no limit never shows red');

// billing cycle
ok(cycleStart('2026-10-15', new Date('2026-10-22T12:00:00Z')) === '2026-10-15', 'cycle started on the 15th of this month');
ok(cycleStart('2026-10-15', new Date('2026-11-10T12:00:00Z')) === '2026-10-15', 'before the 15th it is still last month\'s cycle');
ok(cycleStart('2026-10-15', new Date('2026-11-15T00:00:00Z')) === '2026-11-15', 'on the 15th a new cycle begins');
ok(cycleStart('2026-01-31', new Date('2026-02-28T12:00:00Z')) === '2026-02-28', 'an anchor on the 31st clamps to a short month');
ok(cycleStart('2026-01-31', new Date('2026-03-05T12:00:00Z')) === '2026-02-28', 'and the cycle before March 31 starts Feb 28');
ok(cycleStart('2026-10-15', new Date('2026-09-01T00:00:00Z')) === '2026-10-15', 'never earlier than the anchor');
ok(cycleStart('garbage') === null, 'bad anchor gives null');
ok(cycleStart('2026-12-20', new Date('2027-01-05T00:00:00Z')) === '2026-12-20', 'cycles cross the new year');

console.log(`plans: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
