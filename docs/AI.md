# AI in SoloCart

Everything under `server/ai/` is optional. **SoloCart works with zero keys**;
a key improves extraction quality, never availability.

## The provider chain (`server/ai/providers.mjs`)

Ported from Butler's `gemini.ts`, retargeted for a text-only seller desk.

- Providers: **OpenAI** (Responses API), **Gemini** (`generateContent`),
  **OpenRouter** and **Groq** (OpenAI-compatible chat completions).
- Order: `AI_PROVIDER_ORDER` (default `openai,gemini,openrouter,groq`),
  filtered to the providers that actually have a key.
- **Multiple keys per provider**, comma-separated
  (`GEMINI_API_KEY=key1,key2`). Each key is tried before moving on.
- Any failure — 401, 403, 429, 5xx, timeout, unparseable JSON — falls
  through to the next key, then the next provider. When everything fails,
  the caller gets one combined error and the **local parser takes over**.
  The seller never sees a provider error for an order draft.
- Gemini model names churn, so the chain lists the key's models and ranks
  them (stable before preview, Lite before Flash, newest first), with a
  sane built-in fallback when the listing call fails.
- `/api/config` reports `providers: [{id, live, keys, model}]` — counts and
  model names only, never key material. Provider errors are scrubbed of
  anything key-shaped before they are logged.

## Order extraction (`server/ai/orders.mjs`)

Three layers, cheapest first:

1. **Rules** — `"2 baskets $18 delivery $5"` is fully determined by the
   segmentation and grammar in `rules.mjs`, so no model is called at all.
   The response says `mode: "rules"` so the UI can say so.
2. **Providers** — the message is wrapped as untrusted data in
   `<customer_message>` tags, the system prompt explicitly says to ignore
   any instruction inside it, and the reply is constrained to a JSON schema.
3. **Local parser** — the original regex parser, now also splitting run-on
   messages at each `$price` boundary.

The model's JSON is **never trusted because it came from a model**:
`validateExtraction()` re-checks the shape, clamps quantities to 1–99 and
prices to $0–$10,000, strips markup from names, and refuses an empty item
list. A `$0` unit price is allowed as a *draft placeholder* (the prompt asks
the model to use it when no price was stated); `validateOrder` still refuses
it at checkout, so a placeholder can never be paid.

**The AI can never start checkout or capture.** It drafts; the seller edits;
only the seller's click creates a PayPal order.

## Rules (`server/ai/rules.mjs`)

Derived in spirit from Butler's `rules.ts`:

- `segmentChunks()` splits on commas/newlines and then at each `$price`
  boundary, so `"2 baskets $18 delivery $5"` becomes the two clauses it is.
- `isExplicitOrder()` is true only when *every* clause parses and there is no
  question — that is what "skip the LLM" means here.
- `classify()` labels a message `order` / `question` / `greeting` / `other`
  for routing.
- `extractUrl()` / `cleanUrl()` ported unchanged (tracking params stripped).

## Ask Byte (`server/ai/assistant.mjs`)

One message in, **one action out** (ported from Butler's `command.ts`):

| Action | Kind | Examples |
| --- | --- | --- |
| `orders` | read | "show unpaid orders" |
| `totals` | read | "how much did I make this week" |
| `recall` | read | "what did Amira order?" |
| `checkout_link` | read | "resend checkout link for Amira" |
| `remind` | **write** | "remind me to ship order 12 tomorrow at 9am" |
| `spend` | **write** | "I spent $40 on boxes" |
| `cancel_order` | **write** | "cancel that checkout" |
| `forget` | **write** | "forget what I told you about Fridays" |
| `answer` | read | anything else |

Guarantees:

- **Writes are gated in code.** `WRITE_ACTIONS` decides, not a model field.
  A write plan is parked server-side under a single-use token with a 5-minute
  TTL; `POST /api/ask/confirm` is the only path that runs it, and the token
  is deleted on first use (approve *or* cancel).
- **Plans are validated** by `normalizePlan()`: unknown actions become
  `answer`, dates must parse, periods are clamped to today/week/month/year,
  order ids must look like ids, amounts must be positive.
- **Zero keys still work**: `planFromRules()` covers the everyday commands,
  and a model failure silently falls back to it.
- Ownership is re-checked at execution — a token from another account, or an
  order id that is not yours, gets nothing.

Voice input uses the Web Speech API in the browser when it exists; typed
input always works.

## Memory (`server/ai/memory.mjs`)

- Short-term conversation: the last 12 turns inside 48 hours (pruned after
  30 days).
- Seller facts: up to 200, deduplicated, listed and deletable in Settings.
  `cleanFact()` refuses anything that looks like a password, PIN, OTP, API
  key, seed phrase or card number — secrets are never stored.

## Recall (`server/ai/recall.mjs`)

Answers questions from the seller's own orders only. Candidate orders are
scored against the question's terms; with a provider the model must name the
order numbers (`used`) its answer rests on, and those become the sources
printed with the answer. With zero keys a keyword search answers instead,
still with sources. Every claim carries an order id.

## Totals (`server/summaries/spending.mjs`)

Revenue = captured + settled orders. Expenses = rows logged through Ask Byte
or the API. Both are summed **in SQL/JavaScript for a calendar period in the
seller's time zone** — the model may pick the period, it never does the
arithmetic, so the numbers are right even when the model is wrong.
