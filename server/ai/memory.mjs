/**
 * Byte's memory of a seller's desk, ported from Butler's `memory.ts`.
 *
 * Two halves:
 *   - short-term chat context (the last few Ask Byte turns, so "and this
 *     week?" still means something),
 *   - lasting facts about the seller, which Settings can list and forget.
 *
 * Both have limits on purpose: a prompt can only hold so much, secrets never
 * get stored, and everything the seller sees can be deleted by them.
 */
import { randomUUID } from 'node:crypto';

import { getDb } from '../db.mjs';

/** How many turns of context a reply sees, and how far back. */
export const HISTORY_TURNS = 12;
export const HISTORY_HOURS = 48;
/** The most facts kept; past this the oldest learned ones go first. */
export const MAX_FACTS = 200;
const FACTS_CHARS = 4000;
const TURN_CHARS = 600;

/** Things never worth keeping: passwords, codes, card and account numbers. */
const SECRET = /pass(word|code|phrase)|\bpin\b|\botp\b|\bcvv\b|security code|secret word|api key|token|seed phrase|\b\d[\d -]{11,22}\d\b/i;

/** A fact as it's kept: one tidy line, or null if empty, too long or a secret. */
export function cleanFact(text) {
  if (typeof text !== 'string') return null;
  const fact = text.replace(/\s+/g, ' ').trim().replace(/^[-•*]\s*/, '');
  if (fact.length < 3 || fact.length > 300 || SECRET.test(fact)) return null;
  return fact;
}

// --- short-term conversation ------------------------------------------------------

/** Adds one turn of the Ask Byte conversation. */
export function addTurn(userId, role, text) {
  getDb()
    .prepare('INSERT INTO chat_turns (user_id, role, text, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, role, String(text || '').slice(0, 2000), Date.now());
}

/** The latest turns, oldest first, for the prompt. */
export function recentTurns(userId, limit = HISTORY_TURNS) {
  const since = Date.now() - HISTORY_HOURS * 60 * 60 * 1000;
  return getDb()
    .prepare('SELECT role, text, created_at FROM chat_turns WHERE user_id = ? AND created_at > ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(userId, since, limit)
    .reverse();
}

/** The conversation for the AI, oldest first, each line with when it was said. */
export function historyText(turns) {
  const when = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
  return turns
    .map((turn) => {
      const text = turn.text.length > TURN_CHARS ? `${turn.text.slice(0, TURN_CHARS)}…` : turn.text;
      return `[${when.format(new Date(turn.created_at))}] ${turn.role === 'seller' ? 'seller' : 'byte'}: ${text}`;
    })
    .join('\n');
}

/** Drops turns older than the history window. */
export function pruneTurns() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return getDb().prepare('DELETE FROM chat_turns WHERE created_at < ?').run(cutoff).changes;
}

// --- lasting facts ------------------------------------------------------------------

export function listFacts(userId) {
  return getDb()
    .prepare('SELECT id, text, source, created_at FROM facts WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, MAX_FACTS)
    .map((row) => ({ id: row.id, text: row.text, source: row.source, createdAt: row.created_at }));
}

/** Keeps facts not already known (same words, ignoring case). Returns the added. */
export function remember(userId, candidates, source = 'learned') {
  const known = new Set(listFacts(userId).map((fact) => fact.text.toLowerCase()));
  const added = [];
  for (const raw of (Array.isArray(candidates) ? candidates : [candidates]).slice(0, 5)) {
    const fact = cleanFact(raw);
    if (!fact || known.has(fact.toLowerCase())) continue;
    getDb()
      .prepare('INSERT INTO facts (id, user_id, text, source, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), userId, fact, source, Date.now());
    known.add(fact.toLowerCase());
    added.push(fact);
  }
  if (added.length) {
    // Keep told facts over learned ones when trimming to the cap.
    getDb()
      .prepare(`DELETE FROM facts WHERE user_id = ? AND id IN (
        SELECT id FROM facts WHERE user_id = ? ORDER BY (source = 'told') DESC, created_at DESC LIMIT -1 OFFSET ?)`)
      .run(userId, userId, MAX_FACTS);
  }
  return added;
}

export function forgetFact(userId, factId) {
  return getDb().prepare('DELETE FROM facts WHERE id = ? AND user_id = ?').run(String(factId || ''), userId).changes > 0;
}

export function forgetAllFacts(userId) {
  return getDb().prepare('DELETE FROM facts WHERE user_id = ?').run(userId).changes;
}

/** What Byte knows about this seller, numbered for the prompt, newest first. */
export function factsText(userId) {
  const lines = [];
  let used = 0;
  for (const [index, fact] of listFacts(userId).entries()) {
    const line = `[${index + 1}] ${fact.text}`;
    if (used + line.length > FACTS_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}
