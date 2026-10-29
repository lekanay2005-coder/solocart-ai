/**
 * AI provider fallback chain, ported from Butler's `gemini.ts`.
 *
 * Several providers, several keys each, tried in `AI_PROVIDER_ORDER`:
 * every failure — bad key, quota, timeout, 5xx — falls through to the next
 * key, then the next provider. When nothing answers, the caller falls back to
 * the local parser, so the app works with zero keys and degrades quietly with
 * a broken one.
 *
 * Keys never leave the server. `/api/config` reports liveness only.
 *
 * Every call takes an injectable `fetchImpl`, so tests can mock providers
 * without touching the network.
 */

const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    urlEnv: 'OPENAI_URL',
    url: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    kind: 'responses',
  },
  gemini: {
    label: 'Gemini',
    keyEnv: 'GEMINI_API_KEY',
    modelEnv: 'GEMINI_MODEL',
    urlEnv: 'GEMINI_URL',
    url: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash',
    kind: 'gemini',
  },
  openrouter: {
    label: 'OpenRouter',
    keyEnv: 'OPENROUTER_API_KEY',
    modelEnv: 'OPENROUTER_MODEL',
    urlEnv: 'OPENROUTER_URL',
    url: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-2.5-flash',
    kind: 'chat',
  },
  groq: {
    label: 'Groq',
    keyEnv: 'GROQ_API_KEY',
    modelEnv: 'GROQ_MODEL',
    urlEnv: 'GROQ_URL',
    url: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    kind: 'chat',
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

/** Several keys per provider are allowed: comma-separated in the env var. */
export function keysFor(id) {
  const spec = PROVIDERS[id];
  if (!spec) return [];
  return String(process.env[spec.keyEnv] || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

/** The providers with at least one key, in the configured order. */
export function providerOrder() {
  const configured = String(process.env.AI_PROVIDER_ORDER || 'openai,gemini,openrouter,groq')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => PROVIDERS[name]);
  return [...new Set(configured)].filter((id) => keysFor(id).length > 0);
}

/** Whether any provider is set up at all. */
export const providersReady = () => providerOrder().length > 0;

/** Liveness report for `/api/config` — counts and model names, never keys. */
export function providerStatus() {
  return PROVIDER_IDS.map((id) => {
    const spec = PROVIDERS[id];
    const keys = keysFor(id);
    return {
      id,
      label: spec.label,
      live: keys.length > 0,
      keys: keys.length,
      model: keys.length ? (process.env[spec.modelEnv] || spec.model) : null,
    };
  });
}

/** A friendly label for the UI: "OpenAI · gpt-4.1-mini", or null. */
export function activeLabel() {
  const id = providerOrder()[0];
  if (!id) return null;
  const spec = PROVIDERS[id];
  return `${spec.label} · ${process.env[spec.modelEnv] || spec.model}`;
}

// --- one call, one provider ------------------------------------------------------

/**
 * @param {{
 *   key: string, provider: string, system?: string, prompt: string,
 *   json?: object, strict?: boolean, maxTokens?: number, timeoutMs?: number,
 *   fetchImpl?: typeof fetch
 * }} input
 * @returns {Promise<string>} the model's text
 */
async function askProvider(input) {
  const spec = PROVIDERS[input.provider];
  if (spec.kind === 'gemini') return askGemini(input, spec);
  if (spec.kind === 'responses') return askOpenAIResponses(input, spec);
  return askOpenAICompatible(input, spec);
}

/** OpenAI Responses API — SoloCart's original path, now one link in the chain. */
async function askOpenAIResponses({ key, system, prompt, json, strict, maxTokens = 700, timeoutMs = 30_000, fetchImpl = fetch }, spec) {
  const model = process.env[spec.modelEnv] || spec.model;
  const base = process.env[spec.urlEnv] || spec.url;
  const response = await fetchImpl(`${base}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      store: false,
      max_output_tokens: maxTokens,
      ...(system ? { instructions: system } : {}),
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
      ...(json ? { text: { format: { type: 'json_schema', name: 'answer', strict: Boolean(strict), schema: json } } } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw providerError(spec.label, model, response.status, payload);
  const text = (payload.output || [])
    .flatMap((entry) => entry.content || [])
    .find((entry) => entry.type === 'output_text')?.text;
  if (!text) throw providerError(spec.label, model, 502, { error: { message: 'empty output' } });
  return text;
}

/** Gemini generateContent, with model discovery so a stale name can't break it. */
async function askGemini({ key, system, prompt, json, maxTokens = 700, timeoutMs = 30_000, fetchImpl = fetch }, spec) {
  const base = process.env[spec.urlEnv] || spec.url;
  let lastError = null;
  for (const model of await modelsFor(key, spec, fetchImpl)) {
    try {
      const response = await fetchImpl(`${base}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          generationConfig: {
            temperature: 0,
            maxOutputTokens: maxTokens,
            ...(json ? { responseMimeType: 'application/json' } : {}),
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        lastError = providerError(spec.label, model, response.status, payload);
        // A rejected key fails on every model; a model gap should try the next model.
        if (/API key/i.test(JSON.stringify(payload))) throw lastError;
        continue;
      }
      const text = (payload.candidates || [])[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
      if (!text) {
        lastError = providerError(spec.label, model, 502, { error: { message: 'empty output' } });
        continue;
      }
      return text;
    } catch (error) {
      if (error?.providerMessage) throw error;
      lastError = error;
    }
  }
  throw lastError || providerError(spec.label, 'any model', 502, { error: { message: 'no model answered' } });
}

/** OpenAI-compatible chat completions: OpenRouter, Groq, and friends. */
async function askOpenAICompatible({ key, system, prompt, json, maxTokens = 700, timeoutMs = 30_000, fetchImpl = fetch }, spec) {
  const model = process.env[spec.modelEnv] || spec.model;
  const base = process.env[spec.urlEnv] || spec.url;
  const response = await fetchImpl(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system || 'Answer with one JSON object only.' },
        { role: 'user', content: prompt },
      ],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw providerError(spec.label, model, response.status, payload);
  const text = payload.choices?.[0]?.message?.content;
  if (!text) throw providerError(spec.label, model, 502, { error: { message: 'empty output' } });
  return text;
}

/**
 * The fast general models this Gemini key may use, best first: stable before
 * preview, Flash-Lite before Flash, newest last (ported from Butler, which
 * learned the hard way that model names churn).
 */
const FALLBACK_GEMINI = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-flash-lite-latest'];
const LIST_TTL_MS = 6 * 60 * 60 * 1000;
const listed = new Map();

export function fastestGemini(names) {
  const usable = names.filter((name) => /^gemini-.*flash/.test(name) && !/image|tts|audio|live|exp|embedding|8b|computer/.test(name));
  const version = (name) => (name.includes('-latest') ? Infinity : Number(name.match(/^gemini-(\d+(?:\.\d+)?)/)?.[1] ?? 0));
  const preview = (name) => (/preview/.test(name) ? 1 : 0);
  const lite = (name) => (name.includes('lite') ? 0 : 1);
  return usable.sort((a, b) => preview(a) - preview(b) || lite(a) - lite(b) || version(b) - version(a) || a.localeCompare(b));
}

async function geminiModels(key, spec, fetchImpl) {
  const chosen = process.env[spec.modelEnv];
  const base = process.env[spec.urlEnv] || spec.url;
  const cacheKey = `${base} ${key}`;
  const cached = listed.get(cacheKey);
  let names = null;
  if (!cached || Date.now() - cached.at > LIST_TTL_MS) {
    try {
      const response = await fetchImpl(`${base}/models?pageSize=1000`, {
        headers: { 'x-goog-api-key': key },
        signal: AbortSignal.timeout(8000),
      });
      const payload = await response.json();
      if (response.ok && Array.isArray(payload.models)) {
        names = payload.models
          .filter((model) => model.name && model.supportedGenerationMethods?.includes('generateContent'))
          .map((model) => model.name.replace(/^models\//, ''));
        listed.set(cacheKey, { at: Date.now(), names });
      }
    } catch {
      names = null;
    }
  } else {
    names = cached.names;
  }
  const ranked = names ? fastestGemini(names) : FALLBACK_GEMINI;
  const first = chosen && (!names || names.includes(chosen)) ? [chosen] : [];
  return [...new Set([...first, ...(ranked.length ? ranked : FALLBACK_GEMINI)])].slice(0, 4);
}

/** Test hook: forget cached Gemini model lists. */
export function clearModelCache() {
  listed.clear();
}

// --- the chain --------------------------------------------------------------------

/** Redacts anything key-shaped from an error message before it is logged. */
export function scrubSecrets(text) {
  return String(text)
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-…[redacted]')
    .replace(/\bsk-or-v1-[A-Za-z0-9_-]{6,}/g, 'sk-or-…[redacted]')
    .replace(/\bgsk_[A-Za-z0-9_-]{6,}/g, 'gsk_…[redacted]')
    .replace(/\bgemini_[A-Za-z0-9_-]{6,}/g, 'gemini_…[redacted]')
    .replace(/\bAIza[A-Za-z0-9_-]{10,}/g, 'AIza…[redacted]');
}

function providerError(label, model, status, payload) {
  const message = scrubSecrets(String(payload?.error?.message || payload?.message || `HTTP ${status}`)).slice(0, 200);
  const error = new Error(`${label} ${model}: ${message}`);
  error.status = status;
  error.providerMessage = true;
  return error;
}

/** True when retrying the same key cannot possibly help. */
const isHopeless = (error) => error?.status === 401 || error?.status === 403;

/**
 * Asks the chain for one answer. Tries every key of every configured provider,
 * in order, and throws one combined error if all of them fail — the caller
 * decides whether that is fatal (it usually isn't; fall back to local rules).
 *
 * @param {{ system?: string, prompt: string, json?: object, strict?: boolean,
 *           maxTokens?: number, timeoutMs?: number, fetchImpl?: typeof fetch }} input
 * @returns {Promise<{ text: string, provider: string, model: string }>}
 */
export function complete(input) {
  const order = providerOrder();
  if (!order.length) {
    const error = new Error('no AI provider is set: add OPENAI_API_KEY (or a backup) on the server');
    error.code = 'no_provider';
    return Promise.reject(error);
  }
  const fetchImpl = input.fetchImpl || fetch;
  const errors = [];
  const run = async () => {
    for (const provider of order) {
      const spec = PROVIDERS[provider];
      for (const [index, key] of keysFor(provider).entries()) {
        try {
          const text = await askProvider({ ...input, provider, key, fetchImpl });
          return { text, provider, model: process.env[spec.modelEnv] || spec.model, label: spec.label };
        } catch (error) {
          errors.push(`#${index + 1} ${String(error?.message || error).slice(0, 160)}`);
          if (isHopeless(error)) break; // a bad key fails for every model
        }
      }
    }
    const combined = new Error(scrubSecrets(`no AI provider answered: ${errors.join(' | ')}`));
    combined.code = 'no_provider';
    throw combined;
  };
  return run();
}

/**
 * `complete`, plus JSON parsing with fence-stripping. Schema *validation* is
 * the caller's job — the model's JSON is never trusted just because it parsed.
 */
export async function completeJson(input) {
  const { text, provider, model, label } = await complete(input);
  let parsed;
  try {
    parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    const error = new Error(`${label} returned JSON that could not be read: ${text.slice(0, 160)}`);
    error.code = 'bad_json';
    throw error;
  }
  return { data: parsed, provider, model, label };
}
