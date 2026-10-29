/**
 * Cheap classification that runs before (and instead of) the LLM — ported in
 * spirit from Butler's `rules.ts`, retargeted for a seller desk.
 *
 * The point is the same: a message like "2 baskets $18 delivery $5" is
 * completely determined by rules the local parser already implements, so no
 * key, no network call and no model are needed to draft it.
 */

/** First http(s) URL in a piece of text, without trailing punctuation. */
export function extractUrl(text) {
  const match = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0].replace(/[.,;:!?)\]]+$/, '') : null;
}

/** Strips tracking parameters so the same link shared twice looks the same. */
export function cleanUrl(url) {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|igsh|igshid|si$|_r$|_t$|fbclid|share_)/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

const QUESTION_RE = /(\?|\b(how much|how many|what|when|where|who|why|could you|can you|do you|does the|is the|are the|will you|would you|tell me)\b)/i;

const FEE_RE = /^(?:shipping|delivery|postage)(?:\s+fee)?\s*(?:is|:)?\s*\$?(\d+(?:\.\d{1,2})?)$/i;
const LEAD_FEE_RE = /^\$?(\d+(?:\.\d{1,2})?)\s*(?:for\s+)?(?:delivery|shipping|postage)\b/i;
const PRODUCT_RE = /^(?:(\d+)\s*(?:x|×)?\s+)?(.+?)\s+(?:at|for)\s+\$?(\d+(?:\.\d{1,2})?)\s*(?:each|per\s+(?:item|unit))?$/i;
const QTY_PRICED_RE = /^(?:(\d+)\s*(?:x|×)?\s+)?(.+?)\s+\$?(\d+(?:\.\d{1,2})?)$/i;
const PRICED_RE = /^(.+?)\s+\$?(\d+(?:\.\d{1,2})?)$/i;

const PRICE_G = /\$\d+(?:\.\d{1,2})?/g;

/**
 * Splits a message the way a person meant it: on commas and newlines, and
 * then again at each `$price` boundary inside one, so "2 baskets $18 delivery
 * $5" becomes the two clauses it obviously is. This is the segmentation the
 * local parser and the rules share, so what skips the LLM is exactly what the
 * LLM would have produced.
 */
export function segmentChunks(text) {
  const chunks = [];
  for (const raw of String(text || '').split(/[,;\n]+/)) {
    const chunk = raw.trim();
    if (!chunk) continue;
    const prices = [...chunk.matchAll(PRICE_G)];
    if (prices.length < 2) {
      chunks.push(chunk);
      continue;
    }
    let cursor = 0;
    for (const price of prices) {
      const end = price.index + price[0].length;
      const piece = chunk.slice(cursor, end).trim();
      if (piece) chunks.push(piece);
      cursor = end;
    }
    const tail = chunk.slice(cursor).trim();
    if (tail) chunks.push(tail);
  }
  return chunks;
}

/** One clause, read the way the local parser reads it. */
function classifyChunk(chunk) {
  if (FEE_RE.test(chunk) || LEAD_FEE_RE.test(chunk)) return { kind: 'fee' };
  if (PRODUCT_RE.test(chunk)) return { kind: 'item', hasPrice: true };
  if (QTY_PRICED_RE.test(chunk)) return { kind: 'item', hasPrice: true };
  if (PRICED_RE.test(chunk)) return { kind: 'item', hasPrice: true };
  return { kind: 'unknown' };
}

const chunksOf = segmentChunks;

/**
 * True when every part of the message is already unambiguous — a price list,
 * no questions, nothing the rules cannot read. Then the LLM is skipped.
 */
export function isExplicitOrder(text) {
  const chunks = chunksOf(text);
  if (!chunks.length || QUESTION_RE.test(text)) return false;
  const classified = chunks.map(classifyChunk);
  if (classified.some((entry) => entry.kind === 'unknown')) return false;
  return classified.some((entry) => entry.kind === 'item');
}

/** True when the message is worth sending to an LLM at all. */
export function looksLikeOrder(text) {
  if (!text || text.length > 1200) return false;
  return /\$\s*\d|\d+(?:\.\d{1,2})\s*(?:each|per)?/i.test(text)
    && !/^\s*(hi|hey|hello|thanks|thank you|ok|okay|cool|yes|no)\s*[.!]?$/i.test(text);
}

/**
 * Cheap label for routing: `order` (draft it), `question` (answer or recall),
 * `greeting`/`smalltalk` (reply only). Classification, not judgement — the
 * seller still reviews every draft.
 */
export function classify(text) {
  const value = String(text || '').trim();
  if (!value) return 'other';
  if (isExplicitOrder(value)) return 'order';
  if (QUESTION_RE.test(value)) return 'question';
  if (looksLikeOrder(value)) return 'order';
  if (/^\s*(hi|hey|hello|thanks|thank you|ok|okay|cool|cheers)\b/i.test(value)) return 'greeting';
  return 'other';
}
