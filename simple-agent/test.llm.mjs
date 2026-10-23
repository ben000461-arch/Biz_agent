// Tests for llm.js — no network: a fake fetch plays Groq and Ollama.
import { createLLM, LLMError } from './llm.js';
import { PLANS, ADMIN } from './plans.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

// A scripted fake: each entry answers one call, in order. url tells us which provider was hit.
function fake(script) {
  const calls = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    const step = script.shift();
    if (!step) throw new Error('script ran out');
    if (step.throw) { const e = new Error('x'); e.name = step.throw; throw e; }
    const groq = url.includes('groq');
    const payload = groq ? { choices: [{ message: { content: step.text ?? '' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
      : { message: { content: step.text ?? '' }, prompt_eval_count: 7, eval_count: 3 };
    return { ok: (step.status || 200) < 400, status: step.status || 200, json: async () => (step.badJson ? Promise.reject(new Error('bad')) : payload) };
  };
  f.calls = calls;
  return f;
}
const mk = (script, extra = {}) => { const f = fake(script); return { f, llm: createLLM({ groqKey: 'gsk_test', fetchImpl: f, retryDelayMs: 1, ...extra }) }; };

// 1. happy path, Pro chat -> large first
{
  const { f, llm } = mk([{ text: 'hello' }]);
  const r = await llm.run(PLANS.pro, 'chat', { system: 's', user: 'hi' });
  ok(r.text === 'hello' && r.tier === 'large' && r.degraded === false, 'pro chat uses large');
  ok(f.calls[0].body.model === 'openai/gpt-oss-120b', 'large model name sent');
  ok(f.calls[0].body.reasoning_effort === 'low', 'reasoning effort low for gpt-oss');
  ok(f.calls[0].headers.authorization === 'Bearer gsk_test', 'key sent as bearer');
  ok(r.usage.in === 10 && r.usage.out === 5, 'usage recorded');
}
// 2. Starter chat -> small, no reasoning flag for other models
{
  const { f, llm } = mk([{ text: 'x' }], { models: { small: 'llama-x' } });
  const r = await llm.run(PLANS.starter, 'chat', { system: 's', user: 'hi' });
  ok(r.tier === 'small' && !('reasoning_effort' in f.calls[0].body), 'non-gpt-oss gets no reasoning flag');
}
// 3. json mode parses and asks for json
{
  const { f, llm } = mk([{ text: '{"a":1}' }]);
  const r = await llm.run(PLANS.pro, 'router', { system: 's', user: 'u', json: true });
  ok(r.data.a === 1 && f.calls[0].body.response_format?.type === 'json_object', 'json parsed + requested');
}
// 4. bad json once -> retry same model succeeds
{
  const { f, llm } = mk([{ text: 'not json' }, { text: '{"b":2}' }]);
  const r = await llm.run(PLANS.pro, 'writer', { system: 's', user: 'u', json: true });
  ok(r.data.b === 2 && r.tier === 'large' && !r.degraded && f.calls.length === 2, 'bad json retried once on same model');
}
// 5. 429 then ok -> retry
{
  const { llm } = mk([{ status: 429 }, { text: 'fine' }]);
  const r = await llm.run(PLANS.pro, 'chat', { system: 's', user: 'u' });
  ok(r.text === 'fine' && r.tier === 'large', '429 retried');
}
// 6. large dead (two 500s) -> falls to small, degraded
{
  const { llm } = mk([{ status: 500 }, { status: 500 }, { text: 'from small' }]);
  const r = await llm.run(PLANS.pro, 'chat', { system: 's', user: 'u' });
  ok(r.tier === 'small' && r.degraded === true && r.firstChoice === 'large', 'falls back to small and says so');
}
// 7. 404 (model missing) does not retry, moves on immediately
{
  const { f, llm } = mk([{ status: 404 }, { text: 'ok' }]);
  const r = await llm.run(PLANS.pro, 'chat', { system: 's', user: 'u' });
  ok(r.tier === 'small' && f.calls.length === 2, '404 not retried');
}
// 8. all hosted down -> local (ollama url), Starter chain small -> local
{
  const { f, llm } = mk([{ status: 503 }, { status: 503 }, { text: '{"x":1}' }]);
  const r = await llm.run(PLANS.starter, 'router', { system: 's', user: 'u', json: true });
  ok(r.tier === 'local' && f.calls[2].url.includes('11434') && f.calls[2].body.format === 'json', 'falls to local ollama with json format');
  ok(r.usage.in === 7, 'ollama usage read');
}
// 9. everything down -> LLMError with attempts, no key leaked
{
  const { llm } = mk([{ throw: 'TimeoutError' }, { throw: 'TimeoutError' }, { status: 500 }, { status: 500 }, { throw: 'TypeError' }, { throw: 'TypeError' }]);
  let err;
  try { await llm.run(PLANS.pro, 'chat', { system: 's', user: 'u' }); } catch (e) { err = e; }
  ok(err instanceof LLMError && err.attempts.length === 6, 'LLMError with all attempts');
  ok(!JSON.stringify(err.attempts).includes('gsk_') && !err.message.includes('gsk_'), 'key not in error');
  ok(err.attempts[0].reason === 'timeout', 'timeout reason');
}
// 10. no key -> hosted tiers skipped, local used
{
  const f = fake([{ text: 'local answer' }]);
  const llm = createLLM({ groqKey: '', fetchImpl: f, retryDelayMs: 1 });
  const r = await llm.run(PLANS.pro, 'chat', { system: 's', user: 'u' });
  ok(r.tier === 'local', 'no key uses local');
  ok(f.calls.length === 1 && f.calls[0].url.includes('11434'), 'no groq call without key');
}
// 11. tierOverride forces cheap tier first (out of credits)
{
  const { f, llm } = mk([{ text: 'cheap' }]);
  const r = await llm.run(PLANS.pro, 'chat', { system: 's', user: 'u', tierOverride: 'small' });
  ok(r.tier === 'small' && f.calls[0].body.model === 'openai/gpt-oss-20b', 'override picks small');
}
// 12. log gets metadata only
{
  const logs = [];
  const f = fake([{ text: 'secret reply' }]);
  const llm = createLLM({ groqKey: 'gsk_test', fetchImpl: f, log: (r) => logs.push(r) });
  await llm.run(PLANS.pro, 'chat', { system: 'sys', user: 'private question' });
  ok(logs.length === 1 && !JSON.stringify(logs).includes('private') && !JSON.stringify(logs).includes('secret'), 'log has no message text');
}
// 13. history is passed through in order
{
  const { f, llm } = mk([{ text: 'x' }]);
  await llm.run(PLANS.pro, 'chat', { system: 's', user: 'now', history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] });
  const m = f.calls[0].body.messages;
  ok(m.length === 4 && m[0].role === 'system' && m[3].content === 'now' && m[1].content === 'a', 'history order');
}
// 14. describe() reflects reality; admin + null plan safe
{
  const { llm } = mk([]);
  ok(/larger/.test(llm.describe(PLANS.pro)) && /smaller/.test(llm.describe(PLANS.starter)), 'describe by plan');
  ok(llm.tiersFor(null, 'chat').join() === 'small,local', 'null plan safe tiers');
  ok(llm.tiersFor(ADMIN, 'writer')[0] === 'large', 'admin writer large');
}
// 15. empty answer retried then falls on
{
  const { llm } = mk([{ text: '' }, { text: '' }, { text: 'small ok' }]);
  const r = await llm.run(PLANS.pro, 'chat', { system: 's', user: 'u' });
  ok(r.tier === 'small' && r.text === 'small ok', 'empty answers handled');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
