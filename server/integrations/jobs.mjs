/**
 * A small SQLite-backed job queue with retry — every trigger (schedule, order
 * event, webhook, manual run) enqueues here and one sweeper drains it, so a
 * run that crashes is retried with backoff instead of vanishing, and the Runs
 * history can always say what happened.
 *
 * Butler has no generic queue (its `jobs.ts` tracks laptop commands), so this
 * is the simplest thing that satisfies the shape the brief asks for.
 */
import { getDb } from '../db.mjs';

/** kind -> async (payload, job) => void. Handlers register at module load. */
const handlers = new Map();

export function registerHandler(kind, handler) {
  handlers.set(kind, handler);
}

/** Queues one job to run as soon as possible (or at `runAt`). */
export function enqueue(userId, kind, payload = {}, runAt = Date.now()) {
  const id = crypto.randomUUID();
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO jobs (id, user_id, kind, payload, run_at, attempts, max_attempts, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, 3, 'queued', ?, ?)`).run(
    id, userId ?? null, kind, JSON.stringify(payload), Math.max(runAt, now), now, now,
  );
  return id;
}

/** The jobs whose time has come, claimed one at a time (only one claim wins). */
export function claimDue(now = Date.now(), limit = 10) {
  const db = getDb();
  const rows = db.prepare("SELECT id FROM jobs WHERE state = 'queued' AND run_at <= ? ORDER BY run_at LIMIT ?")
    .all(now, limit);
  const claimed = [];
  for (const row of rows) {
    const result = db.prepare("UPDATE jobs SET state = 'running', updated_at = ? WHERE id = ? AND state = 'queued'")
      .run(now, row.id);
    if (result.changes === 1) claimed.push(row.id);
  }
  if (!claimed.length) return [];
  const placeholders = claimed.map(() => '?').join(', ');
  return db.prepare(`SELECT * FROM jobs WHERE id IN (${placeholders})`).all(...claimed);
}

const readJob = (job) => ({ ...job, payload: JSON.parse(job.payload || '{}') });

/** One job attempt: success -> done, failure -> retry with backoff, then failed. */
export async function runJob(rawJob) {
  const job = readJob(rawJob);
  const handler = handlers.get(job.kind);
  if (!handler) return finish(job, 'failed', `no handler for "${job.kind}"`);
  try {
    await handler(job.payload, job);
    return finish(job, 'done', null);
  } catch (error) {
    const attempts = job.attempts + 1;
    const message = String(error?.message || error).slice(0, 300);
    if (attempts >= job.max_attempts) return finish(job, 'failed', message, attempts);
    const backoffMs = 30_000 * 2 ** (attempts - 1);
    getDb().prepare("UPDATE jobs SET state = 'queued', attempts = ?, run_at = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(attempts, Date.now() + backoffMs, message, Date.now(), job.id);
    return { ...job, attempts, state: 'queued', lastError: message };
  }
}

function finish(job, state, error, attempts = job.attempts) {
  getDb().prepare('UPDATE jobs SET state = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?')
    .run(state, attempts, error, Date.now(), job.id);
  return { ...job, attempts, state, lastError: error };
}

/** Drains whatever is due. Called by the sweeper and right after an enqueue. */
export async function tick(now = Date.now()) {
  const claimed = claimDue(now);
  const results = [];
  for (const job of claimed) results.push(await runJob(job));
  return results;
}

export const recentJobs = (userId, limit = 20) => getDb()
  .prepare('SELECT id, kind, state, attempts, last_error, run_at, created_at FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
  .all(userId, limit)
  .map((row) => ({
    id: row.id,
    kind: row.kind,
    state: row.state,
    attempts: row.attempts,
    lastError: row.last_error,
    runAt: row.run_at,
    createdAt: row.created_at,
  }));
