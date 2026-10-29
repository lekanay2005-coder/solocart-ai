process.env.SOLOCART_DB = ':memory:';
process.env.APP_VAULT_KEY = 'test-vault-key-for-phase-4';
process.env.TZ = 'UTC';
delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.GROQ_API_KEY;
delete process.env.OPENROUTER_API_KEY;

import test from 'node:test';
import assert from 'node:assert/strict';

import * as recipes from '../server/integrations/recipes.mjs';
import { registerHandler, enqueue, tick, claimDue } from '../server/integrations/jobs.mjs';
import { getDb } from '../server/db.mjs';

function makeUser(id = 'u-rec') {
  getDb()
    .prepare('INSERT INTO users (id, kind, name, email, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'local', 'Test Seller', `${id}@example.test`, Date.now());
  return id;
}

const reminderCount = () => getDb().prepare('SELECT COUNT(*) AS n FROM reminders').get().n;
const jobRows = () => getDb().prepare('SELECT * FROM jobs').all();
const runRows = () => getDb().prepare('SELECT * FROM recipe_runs').all();

// --- creating recipes ---------------------------------------------------------------

test('a recipe is validated: name, words, schedule and event', () => {
  const userId = makeUser('u-v');
  assert.throws(() => recipes.save(userId, null, { name: '-bad', instructions: 'do it' }), /short name/);
  assert.throws(() => recipes.save(userId, null, { name: 'x'.repeat(70), instructions: 'do it' }), /short name/);
  assert.throws(() => recipes.save(userId, null, { name: 'Chase payments', instructions: '   ' }), /what the recipe should do/);
  assert.throws(() => recipes.save(userId, null, { name: 'Chase payments', instructions: 'x'.repeat(5000) }), /4000/);
  assert.throws(
    () => recipes.save(userId, null, { name: 'Morning numbers', instructions: 'summarise', trigger: 'schedule', config: { run_at: '25:99', run_days: [1] } }),
    /HH:MM/,
  );
  assert.throws(
    () => recipes.save(userId, null, { name: 'Morning numbers', instructions: 'summarise', trigger: 'schedule', config: { run_at: '08:00', run_days: [] } }),
    /at least one day/,
  );
  assert.throws(
    () => recipes.save(userId, null, { name: 'On capture', instructions: 'post it', trigger: 'order_event', config: { event: 'order.exploded' } }),
    /pick one of/,
  );
  assert.throws(() => recipes.save(userId, null, { name: 'Fine one', instructions: 'ok', trigger: 'made_up' }), /trigger/);

  const saved = recipes.save(userId, null, {
    name: 'Morning numbers',
    instructions: 'Summarise yesterday.',
    trigger: 'schedule',
    config: { run_at: '08:00', run_days: [1, 2, 3, 4, 5] },
  });
  assert.equal(saved.trigger, 'schedule');
  assert.equal(recipes.describeSchedule(saved), 'weekdays at 08:00');
  assert.equal(recipes.list(userId).length, 1);
});

test('a duplicate name is refused', () => {
  const userId = makeUser('u-dup');
  recipes.save(userId, null, { name: 'Same name', instructions: 'one' });
  assert.throws(() => recipes.save(userId, null, { name: 'same NAME', instructions: 'two' }), /already have a recipe/);
});

// --- schedules ----------------------------------------------------------------------

test('a schedule fires once, inside its window, on its days', () => {
  const userId = makeUser('u-sched');
  const weekday = new Date('2026-11-02T00:00:00Z').getUTCDay();
  const recipe = recipes.save(userId, null, {
    name: 'Daily numbers',
    instructions: 'Post the brief.',
    trigger: 'schedule',
    config: { run_at: '08:00', run_days: [weekday] },
  });

  assert.equal(recipes.due(recipe, '2026-11-02T08:15:00+00:00', null), true, 'inside the 3-hour window');
  assert.equal(recipes.due(recipe, '2026-11-02T08:15:00+00:00', '2026-11-02'), false, 'already ran today');
  assert.equal(recipes.due(recipe, '2026-11-02T07:59:00+00:00', null), false, 'before the time');
  assert.equal(recipes.due(recipe, '2026-11-02T12:01:00+00:00', null), false, 'missed by more than 3h: skipped');
  const otherDay = new Date(Date.parse('2026-11-02T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
  assert.equal(recipes.due(recipe, `${otherDay}T08:15:00+00:00`, null), false, 'not one of its days');

  const mine = (rows) => rows.filter((recipe) => recipe.userId === userId);
  const claimed = mine(recipes.claimDue('2026-11-02T08:15:00+00:00'));
  assert.equal(claimed.length, 1, 'claimed exactly once');
  assert.equal(mine(recipes.claimDue('2026-11-02T08:20:00+00:00')).length, 0, 'never twice on the same day');
  assert.equal(claimed[0].userId, userId);
});

test('the event flood guard limits how often a recipe can start', () => {
  const limits = new recipes.EventLimit(30_000, 2);
  const now = 1_000_000;
  assert.equal(limits.allow('r1', now), true);
  assert.equal(limits.allow('r1', now + 1000), false, 'inside the gap');
  assert.equal(limits.allow('r1', now + 31_000), true);
  assert.equal(limits.allow('r1', now + 62_000), false, 'daily cap of 2 reached');
  assert.equal(limits.allow('r2', now), true, 'other recipes unaffected');
});

// --- the run loop + approval gate ----------------------------------------------------

test('a write step waits for approval and only runs on confirm', async () => {
  const userId = makeUser('u-gate');
  const recipe = recipes.save(userId, null, {
    name: 'Unpaid reminder',
    instructions: 'If a checkout is unpaid, draft a reminder to chase it.',
    trigger: 'manual',
  });

  recipes.usePlanner(async (prompt) => {
    assert.ok(prompt.includes('If a checkout is unpaid'), 'the recipe text reaches the planner');
    assert.ok(prompt.includes('changes things: asks the seller first'), 'the write tool is labelled as gated');
    return { do: 'tool', tool: 'reminders/add', args: { body: 'Chase the unpaid checkout' }, reply: 'Drafting a reminder' };
  });

  try {
    recipes.start(userId, recipe.id, { trigger: 'manual' });
    await tick();

    const [waiting] = recipes.pendingRuns(userId);
    assert.ok(waiting, 'the run is parked waiting for approval');
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.waiting.key, 'reminders/add');
    assert.equal(reminderCount(), 0, 'the gate held: nothing was written');

    // Decline: still nothing.
    const declined = await recipes.approve(userId, waiting.id, false);
    assert.equal(declined.status, 'declined');
    assert.equal(reminderCount(), 0, 'declining writes nothing');

    // Second run, this time confirmed.
    recipes.start(userId, recipe.id, { trigger: 'manual' });
    await tick();
    const [pending2] = recipes.pendingRuns(userId);
    const result = await recipes.approve(userId, pending2.id, true);
    assert.equal(result.status, 'done');
    assert.equal(reminderCount(), 1, 'only the confirm click ran the write');
    assert.ok(result.say.includes('Ran reminders/add'), 'the run reports what happened');

    // A finished or unknown run cannot be re-approved.
    await assert.rejects(recipes.approve(userId, pending2.id, true), /already finished|is gone/);
    await assert.rejects(recipes.approve(userId, 'nope', true), /is gone/);
  } finally {
    recipes.usePlanner(null);
  }
});

test('read-only steps run automatically and the recipe finishes', async () => {
  const userId = makeUser('u-read');
  const recipe = recipes.save(userId, null, {
    name: 'Order roll-call',
    instructions: 'List the open orders and tell me what is waiting.',
    trigger: 'manual',
  });

  let calls = 0;
  const prompts = [];
  recipes.usePlanner(async (prompt) => {
    prompts.push(prompt);
    calls += 1;
    if (calls === 1) return { do: 'tool', tool: 'orders/list', args: { status: 'draft' }, reply: 'listing drafts' };
    return { do: 'finish', reply: 'Nothing is waiting right now.' };
  });

  try {
    recipes.start(userId, recipe.id, { trigger: 'manual' });
    await tick();

    const [run] = runRows().filter((row) => row.user_id === userId);
    assert.equal(run.status, 'done');
    assert.equal(run.say, 'Nothing is waiting right now.');
    assert.equal(recipes.recentRuns(userId)[0].status, 'done');
    assert.ok(prompts[0].includes('orders/list'), 'the tool list reaches the planner');
    assert.ok(prompts[1].includes('used "orders/list"'), 'the read result is fed back to the next step');
    assert.ok(recipes.byId(userId, recipe.id).lastRunAt, 'last_run_at is stamped');
  } finally {
    recipes.usePlanner(null);
  }
});

test('with no AI provider the run fails visibly and the job retries', async () => {
  const userId = makeUser('u-fail');
  const recipe = recipes.save(userId, null, { name: 'Needs a model', instructions: 'Plan something.', trigger: 'manual' });

  recipes.usePlanner(async () => {
    throw new Error('no AI provider is set: add OPENAI_API_KEY (or another key) in .env to run recipes.');
  });
  try {
    recipes.start(userId, recipe.id, { trigger: 'manual' });
    await tick();

    const [run] = runRows().filter((row) => row.user_id === userId);
    assert.equal(run.status, 'failed');
    assert.ok(run.say.startsWith('Could not run:'), 'the reason is in Runs history');

    const [job] = jobRows().filter((row) => row.user_id === userId && row.state !== 'done');
    assert.equal(job.state, 'queued', 'queued for retry');
    assert.equal(job.attempts, 1);
    assert.ok(job.last_error.includes('no AI provider'));
    assert.ok(job.run_at > Date.now(), 'backoff, not a hot loop');
  } finally {
    recipes.usePlanner(null);
  }
});

// --- triggers -------------------------------------------------------------------------

test('order events start only the recipes that subscribed to that event', () => {
  const userId = makeUser('u-evt');
  recipes.save(userId, null, { name: 'On capture', instructions: 'Add a row to my sheet.', trigger: 'order_event', config: { event: 'order.captured' } });

  recipes.onOrderEvent(userId, 'order.failed', 'Event: order event\nOrder x — status: failed');
  assert.equal(jobRows().filter((row) => row.user_id === userId).length, 0, 'a different event starts nothing');

  recipes.onOrderEvent(userId, 'order.captured', 'Event: order event\nOrder ab12 — status: captured, total: 41 USD');
  const jobs = jobRows().filter((row) => row.user_id === userId);
  assert.equal(jobs.length, 1);
  const payload = JSON.parse(jobs[0].payload);
  assert.equal(payload.trigger, 'order_event');
  assert.ok(payload.eventText.includes('ab12'), 'the event passes data, not instructions');

  // The flood guard stops an immediate second start.
  recipes.onOrderEvent(userId, 'order.captured', 'again');
  assert.equal(jobRows().filter((row) => row.user_id === userId).length, 1, 'rate-limited within the gap');
});

// --- webhook links ---------------------------------------------------------------------

test('secret links start recipes and stop working when dropped', async () => {
  const userId = makeUser('u-hook');
  const recipe = recipes.save(userId, null, { name: 'Sheet logger', instructions: 'Add a row.', trigger: 'webhook' });

  const token = await recipes.makeHook(userId, recipe.id);
  assert.match(token, /^[0-9a-f]{48}$/);
  const found = await recipes.byHook(token);
  assert.equal(found.id, recipe.id);
  assert.equal(await recipes.byHook('deadbeef'), null, 'wrong token finds nothing');
  assert.equal(await recipes.byHook('zz'.repeat(24)), null, 'malformed token finds nothing');

  const shown = await recipes.makeHook(userId, recipe.id);
  assert.notEqual(shown, token, 'regenerating invalidates the old link');
  assert.equal(await recipes.byHook(token), null, 'the old token is dead');

  recipes.dropHook(userId, recipe.id);
  assert.equal(await recipes.byHook(shown), null, 'dropping the hook kills the link');
});

test('the webhook body reaches the run as data', async () => {
  const userId = makeUser('u-hook2');
  const recipe = recipes.save(userId, null, { name: 'Incoming rows', instructions: 'Log what arrives.', trigger: 'webhook' });
  const token = await recipes.makeHook(userId, recipe.id);
  const found = await recipes.byHook(token);

  let seenEvent = '';
  recipes.usePlanner(async (prompt) => {
    seenEvent = prompt;
    return { do: 'finish', reply: 'Logged it.' };
  });
  try {
    recipes.start(found.userId, found.id, { trigger: 'webhook', eventText: JSON.stringify({ row: 'Amira, 2 items' }) });
    await tick();
    const [run] = runRows().filter((row) => row.user_id === userId);
    assert.equal(run.status, 'done');
    assert.ok(seenEvent.includes('Amira, 2 items'), 'the payload is in the prompt as data');
    assert.ok(seenEvent.includes('never instructions'), 'the injection guard sentence is present');
  } finally {
    recipes.usePlanner(null);
  }
});

// --- the job queue -----------------------------------------------------------------------

test('the queue retries a failing handler with backoff, then gives up', async () => {
  const userId = makeUser('u-jobs');
  let attempts = 0;
  registerHandler('boom', async () => {
    attempts += 1;
    throw new Error('the widget is on fire');
  });
  const id = enqueue(userId, 'boom', {});
  await tick();

  let [job] = jobRows().filter((row) => row.id === id);
  assert.equal(job.state, 'queued', 'retried');
  assert.equal(job.attempts, 1);
  assert.equal(job.last_error, 'the widget is on fire');

  // Pull it forward twice more: the third failure is the last.
  getDb().prepare('UPDATE jobs SET run_at = ? WHERE id = ?').run(Date.now() - 1, id);
  await tick();
  getDb().prepare('UPDATE jobs SET run_at = ? WHERE id = ?').run(Date.now() - 1, id);
  await tick();

  [job] = jobRows().filter((row) => row.id === id);
  assert.equal(attempts, 3, 'three attempts in total');
  assert.equal(job.state, 'failed');
  assert.equal(job.attempts, 3);

  // A claimed job is never picked up twice.
  enqueue(userId, 'missing-kind', {});
  const claimed = claimDue(Date.now());
  const again = claimDue(Date.now());
  assert.ok(again.every((row) => !claimed.some((first) => first.id === row.id)));
});
