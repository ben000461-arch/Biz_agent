// llm.js — the one place the bot talks to language models.
//
// Everything else asks for a ROLE ("router", "writer", "chat") on behalf of a plan, and gets back an answer plus
// a small receipt of what really happened (which model, how long, whether it fell back). Plans say which tier
// each role uses (plans.js); this file turns tiers into real models:
//
//   small = hosted Groq model (default openai/gpt-oss-20b)      large = hosted Groq model (openai/gpt-oss-120b)
//   local = Ollama on your own computer (llama3.2:3b), last fallback only
//
// Rules: a call never hangs (timeouts), a flaky model gets ONE retry, a broken one hands over to the next tier in
// the plan's fallback list, and the receipt says so (degraded: true) so credits are charged for the tier that
// really answered. The API key lives only inside this object and is never logged or put in an error message.

import { PLANS } from './plans.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class LLMError extends Error {
  constructor(message, { attempts = [] } = {}) { super(message); this.name = 'LLMError'; this.attempts = attempts; }
}

// Does this Groq model need the "think less" setting? Only the gpt-oss family understands it.
const isReasoning = (model) => /gpt-oss/i.test(model || '');

export function createLLM({
  groqKey = '',
  groqBase = 'https://api.groq.com/openai/v1',
  ollamaHost = 'http://127.0.0.1:11434',
  models = {},                       // { small, large, local } real model names
  fetchImpl = globalThis.fetch,
  retryDelayMs = 400,
  log = () => {},                    // log(receiptObject) — metadata only, never message text
} = {}) {
  const names = {
    small: models.small || 'openai/gpt-oss-20b',
    large: models.large || 'openai/gpt-oss-120b',
    local: models.local || 'llama3.2:3b',
  };
  const hosted = (tier) => tier === 'small' || tier === 'large';
  const available = (tier) => (hosted(tier) ? Boolean(groqKey) : tier === 'local');

  // One attempt against one model. Returns { text, usage } or throws { retryable, message }.
  async function once(tier, { system, user, history, json, temperature, maxTokens, timeoutMs }) {
    const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: user }];
    let res;
    try {
      if (hosted(tier)) {
        const body = {
          model: names[tier], messages, temperature, max_completion_tokens: maxTokens,
          ...(json ? { response_format: { type: 'json_object' } } : {}),
          ...(isReasoning(names[tier]) ? { reasoning_effort: 'low' } : {}),
        };
        res = await fetchImpl(`${groqBase}/chat/completions`, {
          method: 'POST', signal: AbortSignal.timeout(timeoutMs),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${groqKey}` },
          body: JSON.stringify(body),
        });
      } else {
        res = await fetchImpl(`${ollamaHost}/api/chat`, {
          method: 'POST', signal: AbortSignal.timeout(timeoutMs),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: names.local, messages, stream: false, ...(json ? { format: 'json' } : {}), options: { temperature, num_ctx: 4096, num_predict: maxTokens } }),
        });
      }
    } catch (e) {
      throw { retryable: true, message: e?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
    }
    if (!res.ok) {
      // 429 / 5xx are worth one more try; 400/401/403/404 mean this model will not work for us right now.
      throw { retryable: res.status === 429 || res.status >= 500, message: `http ${res.status}` };
    }
    let data;
    try { data = await res.json(); } catch { throw { retryable: true, message: 'bad response' }; }
    const text = hosted(tier) ? data?.choices?.[0]?.message?.content : data?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw { retryable: true, message: 'empty answer' };
    const usage = hosted(tier)
      ? { in: data.usage?.prompt_tokens ?? null, out: data.usage?.completion_tokens ?? null }
      : { in: data.prompt_eval_count ?? null, out: data.eval_count ?? null };
    return { text, usage };
  }

  // Try each tier in order. Within a tier: one retry for temporary trouble or unparseable JSON.
  // opts: { tiers: ['large','small','local'], system, user, history, json, temperature, maxTokens, timeoutMs }
  async function call(opts) {
    const o = {
      history: [], json: false, temperature: 0, maxTokens: 1024, timeoutMs: 30_000, ...opts,
    };
    const tiers = (o.tiers || []).filter((t, i, a) => a.indexOf(t) === i && available(t));
    if (!tiers.length) throw new LLMError('No model is available right now.');
    const attempts = [];
    for (let i = 0; i < tiers.length; i++) {
      const tier = tiers[i];
      const timeoutMs = tier === 'local' ? Math.max(o.timeoutMs, 90_000) : o.timeoutMs; // a cold local model loads slowly
      for (let attempt = 0; attempt < 2; attempt++) {
        const t0 = Date.now();
        try {
          const { text, usage } = await once(tier, { ...o, timeoutMs });
          let data = text;
          if (o.json) {
            try { data = JSON.parse(text); } catch { throw { retryable: true, message: 'invalid json' }; }
          }
          const receipt = { tier, model: names[tier], degraded: i > 0, firstChoice: tiers[0], ms: Date.now() - t0, usage, attempts: attempts.length + 1 };
          log(receipt);
          return { data, text, ...receipt };
        } catch (e) {
          attempts.push({ tier, model: names[tier], reason: e?.message || 'error', ms: Date.now() - t0 });
          if (!e?.retryable || attempt === 1) break;
          await sleep(retryDelayMs);
        }
      }
    }
    log({ failed: true, attempts });
    throw new LLMError('The assistant could not answer right now.', { attempts });
  }

  // The order to try for one role of one plan: the plan's choice first, then its fallbacks.
  function tiersFor(plan, role) {
    const m = plan?.models;
    if (!m) return ['small', 'local'];
    return [m[role], ...(m.fallback || [])];
  }

  // Convenience: run a role for an entitlement's plan. `tierOverride` lets the credit meter force the cheap tier.
  function run(plan, role, opts = {}) {
    const { tierOverride, ...rest } = opts;
    const tiers = tierOverride ? [tierOverride, ...tiersFor(plan, role).filter((t) => t !== tierOverride)] : tiersFor(plan, role);
    return call({ ...rest, tiers });
  }

  // What to tell someone who asks "what model are you?" — built from what is really configured.
  function describe(plan, role = 'chat') {
    const first = tiersFor(plan, role)[0];
    if (!available(first)) return 'a small AI model on my host computer';
    return hosted(first) ? `the ${first === 'large' ? 'larger' : 'smaller'} hosted AI model for your plan (${names[first]})` : `a small local AI model (${names.local})`;
  }

  return { call, run, tiersFor, describe, names, available };
}

export { PLANS };
