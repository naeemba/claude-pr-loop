// Self-check for workflows/pr-loop.js. Runs the real script with the
// workflow globals (args, agent, phase, log) stubbed, so it needs no forge, no
// network and no subagents.
//   node --test tests/pr-loop.test.js
//
// It lives outside workflows/ on purpose: install.sh links that folder's files into
// ~/.claude/workflows, and a test file there would read as a workflow.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(new URL('../workflows/pr-loop.js', import.meta.url))
// The workflow runner treats the file as an async function body: top-level
// `await` and `return` are allowed, and the globals arrive as parameters. Do
// the same here. `export` is only legal in a module, so drop it.
const scriptBody = readFileSync(scriptPath, 'utf8').replace(/^export const meta/m, 'const meta')
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const runScript = new AsyncFunction('args', 'agent', 'phase', 'log', scriptBody)

// `answers` maps an agent label to what that agent returns.
const runWith = async (args, answers) => {
  const calls = []
  const agent = async (prompt, options) => {
    calls.push({ label: options.label, prompt })
    if (!(options.label in answers)) throw new Error(`unexpected agent ${options.label}`)
    return answers[options.label]
  }
  const result = await runScript(args, agent, () => {}, () => {})
  return { result, calls }
}

const cleanMerge = { summary: 'no conflict', hadConflicts: false, resolved: false, files: [], checks: '' }

const cleanReview = {
  summary: 'nothing to say',
  commentsPostedThisRound: 0,
  unresolvedCommentsRemaining: 0,
  remainingAtOrBelowFloor: [],
  blockedOnHuman: [],
}

test('an unresolved conflict stops the run before any review', async () => {
  const conflicts = {
    summary: 'both sides rewrote the same function',
    hadConflicts: true,
    resolved: false,
    files: ['src/a.ts — left open'],
    checks: '',
  }
  const { result, calls } = await runWith('13', { conflicts })
  assert.equal(result.status, 'conflicts-unresolved')
  assert.equal(result.rounds, 0)
  assert.deepEqual(result.conflicts, conflicts)
  assert.deepEqual(calls.map((call) => call.label), ['conflicts'])
})

test('a clean merge goes on to the review rounds', async () => {
  const { result, calls } = await runWith('13', { conflicts: cleanMerge, 'review-r1': cleanReview })
  assert.equal(result.status, 'converged')
  assert.deepEqual(calls.map((call) => call.label), ['conflicts', 'review-r1'])
})

test('a bare number as args is the PR number', async () => {
  const { result, calls } = await runWith(622, { conflicts: cleanMerge, 'review-r1': cleanReview })
  assert.equal(result.status, 'converged')
  for (const call of calls) assert.match(call.prompt, /with the argument "622"/)
})

test('the result keeps every commit but only a short line per agent', async () => {
  const longSummary = 'x'.repeat(5000)
  const review = {
    summary: longSummary,
    commentsPostedThisRound: 2,
    unresolvedCommentsRemaining: 2,
    remainingAtOrBelowFloor: ['a.ts:1 — [low] — rename', 'b.ts:2 — [nit] — typo'],
    blockedOnHuman: [],
  }
  const fix = {
    summary: longSummary,
    commitShas: ['abc1234', 'def5678'],
    addressed: 1,
    rejected: 1,
    pushed: true,
    rejectedThreads: ['b.ts:2 — the typo is the upstream API spelling'],
  }
  const { result } = await runWith('13', { conflicts: cleanMerge, 'review-r1': review, 'fix-r1': fix })
  assert.equal(result.status, 'floor-addressed')
  assert.deepEqual(result.commitShas, ['abc1234', 'def5678'])
  assert.deepEqual(result.history.map((entry) => entry.stage), ['review', 'fix'])
  assert.deepEqual(result.history[1].rejectedThreads, fix.rejectedThreads)
  assert.ok(JSON.stringify(result).length < 2048)
})

test('an agent error still reports the commits earlier rounds pushed', async () => {
  const review = { ...cleanReview, unresolvedCommentsRemaining: 1 }
  const fix = { summary: 'fixed', commitShas: ['abc1234'], addressed: 1, rejected: 0, pushed: true, rejectedThreads: [] }
  const { result } = await runWith('13', {
    conflicts: cleanMerge,
    'review-r1': review,
    'fix-r1': fix,
    're-review-r2': null,
    're-review-r2-retry': null,
    're-review-r2-retry2': null,
  })
  assert.equal(result.status, 'agent-error')
  assert.deepEqual(result.commitShas, ['abc1234'])
})
