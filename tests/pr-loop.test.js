// Self-check for workflows/pr-loop.js. Runs the real script with the
// workflow globals (args, agent, phase, log) stubbed, so it needs no forge, no
// network and no subagents.
//   node --test tests/pr-loop.test.js
//
// It lives outside workflows/ on purpose: install.sh copies that folder's files into
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
    calls.push({ label: options.label, prompt, options })
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

const floorReview = { ...cleanReview, unresolvedCommentsRemaining: 1, remainingAtOrBelowFloor: ['a.ts:1 — [low] — rename'] }

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
    addressedThreads: ['T1 — a.ts:1 — abc1234 — rename'],
  }
  const check = { summary: longSummary, verdicts: [{ sha: 'abc1234', accepted: true, threads: [], reason: 'ok' }] }
  const { result } = await runWith('13', { conflicts: cleanMerge, 'review-r1': review, 'fix-r1': fix, 'final-check': check })
  assert.equal(result.status, 'floor-addressed')
  assert.deepEqual(result.commitShas, ['abc1234', 'def5678'])
  assert.deepEqual(result.history.map((entry) => entry.stage), ['review', 'fix', 'final-check'])
  assert.deepEqual(result.history[1].rejectedThreads, fix.rejectedThreads)
  assert.ok(JSON.stringify(result).length < 2048)
})

test('a commit the check returns no verdict for is unverified, not accepted', async () => {
  const fix = { ...pushingFix, commitShas: ['abc1234', 'def5678'] }
  const check = {
    summary: 'checked',
    verdicts: [
      { sha: 'abc1234', accepted: true, threads: [], reason: 'ok' },
      { sha: '9999999', accepted: false, threads: [], reason: 'not from this round' },
    ],
  }
  const { result, calls } = await runWith('13', { conflicts: cleanMerge, 'review-r1': floorReview, 'fix-r1': fix, 'final-check': check })
  assert.deepEqual(result.finalCheck, { checked: ['abc1234', 'def5678'], rejected: [], unverified: ['def5678'] })
  assert.deepEqual(result.history.at(-1), { round: 1, stage: 'final-check', accepted: 1, rejected: 0, unverified: 1 })
  assert.ok(!calls.some((call) => call.label === 'final-revert'))
})

test('an agent error still reports the commits earlier rounds pushed', async () => {
  const review = { ...cleanReview, unresolvedCommentsRemaining: 1 }
  const fix = { summary: 'fixed', commitShas: ['abc1234'], addressed: 1, rejected: 0, pushed: true, rejectedThreads: [], addressedThreads: [] }
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

test('review rounds pin opus at high effort, fix and conflicts stay on the session', async () => {
  const fix = { summary: 'fixed', commitShas: [], addressed: 1, rejected: 0, pushed: true, rejectedThreads: [], addressedThreads: [] }
  const { calls } = await runWith('13', { conflicts: cleanMerge, 'review-r1': floorReview, 'fix-r1': fix })
  const byLabel = Object.fromEntries(calls.map((call) => [call.label, call.options]))
  assert.equal(byLabel['review-r1'].model, 'opus')
  assert.equal(byLabel['review-r1'].effort, 'high')
  for (const label of ['conflicts', 'fix-r1']) {
    assert.ok(!('model' in byLabel[label]), `${label} has a model`)
    assert.ok(!('effort' in byLabel[label]), `${label} has an effort`)
  }
})

test('a pinned fix model runs at low effort, a session review model drops both keys', async () => {
  const fix = { summary: 'fixed', commitShas: [], addressed: 1, rejected: 0, pushed: true, rejectedThreads: [], addressedThreads: [] }
  const { calls } = await runWith(
    { pr: '13', fixModel: 'sonnet', reviewModel: null },
    { conflicts: cleanMerge, 'review-r1': floorReview, 'fix-r1': fix },
  )
  const byLabel = Object.fromEntries(calls.map((call) => [call.label, call.options]))
  assert.equal(byLabel['fix-r1'].model, 'sonnet')
  assert.equal(byLabel['fix-r1'].effort, 'low')
  assert.ok(!('model' in byLabel['review-r1']))
  assert.ok(!('effort' in byLabel['review-r1']))
})

test('an unknown model name is rejected before any agent runs', async () => {
  await assert.rejects(runWith({ pr: '13', fixModel: 'gpt' }, {}), /fixModel must be/)
})

test('a conflict step that never answers still lets the rounds run', async () => {
  const { result, calls } = await runWith('13', {
    conflicts: null,
    'conflicts-retry': null,
    'conflicts-retry2': null,
    'review-r1': cleanReview,
  })
  assert.equal(result.status, 'converged')
  assert.equal(result.conflicts, null)
  assert.ok(calls.some((call) => call.label === 'review-r1'))
})

const pushingFix = {
  summary: 'fixed',
  commitShas: ['abc1234'],
  addressed: 1,
  rejected: 0,
  pushed: true,
  rejectedThreads: [],
  addressedThreads: ['T1 — a.ts:1 — abc1234 — rename'],
}
const verdict = (accepted) => ({
  summary: 'checked',
  verdicts: [{ sha: 'abc1234', accepted, threads: ['T1 — a.ts:1 — abc1234 — rename'], reason: accepted ? 'fine' : 'breaks the import' }],
})
const cleanRevert = { summary: 'reverted', revertShas: ['fff0000'], notReverted: [], pushed: true }

test('a final check that accepts ends the run as before, with no revert', async () => {
  const { result, calls } = await runWith('13', {
    conflicts: cleanMerge, 'review-r1': floorReview, 'fix-r1': pushingFix, 'final-check': verdict(true),
  })
  assert.equal(result.status, 'floor-addressed')
  assert.deepEqual(calls.map((call) => call.label), ['conflicts', 'review-r1', 'fix-r1', 'final-check'])
  assert.match(calls[3].prompt, /abc1234/)
  assert.match(calls[3].prompt, /T1 — a\.ts:1/)
  assert.deepEqual(result.blockedOnHuman, [])
})

test('a rejected commit is reverted, handed to a person, and starts no new round', async () => {
  const { result, calls } = await runWith('13', {
    conflicts: cleanMerge, 'review-r1': floorReview, 'fix-r1': pushingFix, 'final-check': verdict(false), 'final-revert': cleanRevert,
  })
  assert.equal(result.status, 'floor-addressed')
  assert.deepEqual(calls.map((call) => call.label), ['conflicts', 'review-r1', 'fix-r1', 'final-check', 'final-revert'])
  assert.match(calls[4].prompt, /git revert --no-edit/)
  assert.match(calls[4].prompt, /unresolveReviewThread/)
  assert.deepEqual(result.commitShas, ['abc1234', 'fff0000'])
  assert.equal(result.blockedOnHuman.length, 1)
  assert.match(result.blockedOnHuman[0], /^T1 — a\.ts:1 .*rejected by the final check, reverted — breaks the import$/)
  assert.deepEqual(result.finalCheck, { checked: ['abc1234'], rejected: ['abc1234'], unverified: [], reverted: ['fff0000'], notReverted: [] })
  assert.ok(JSON.stringify(result).length < 2048)
})

test('a revert that was committed but never pushed counts as nothing reverted', async () => {
  const revert = { ...cleanRevert, pushed: false }
  const { result } = await runWith('13', {
    conflicts: cleanMerge, 'review-r1': floorReview, 'fix-r1': pushingFix, 'final-check': verdict(false), 'final-revert': revert,
  })
  assert.deepEqual(result.commitShas, ['abc1234'])
  assert.match(result.blockedOnHuman[0], /NOT reverted, still on the branch/)
  assert.deepEqual(result.finalCheck.reverted, [])
  assert.deepEqual(result.finalCheck.notReverted, ['abc1234'])
})

test('a final check agent that fails leaves the commits unverified and the run as it was', async () => {
  const { result } = await runWith('13', { conflicts: cleanMerge, 'review-r1': floorReview, 'fix-r1': pushingFix })
  assert.equal(result.status, 'floor-addressed')
  assert.equal(result.finalCheck.verdicts, null)
  assert.deepEqual(result.blockedOnHuman, [])
  assert.ok(!result.history.some((entry) => entry.stage === 'final-check'))
})

test('a revert agent that fails reports the rejected commit as still on the branch', async () => {
  const { result } = await runWith('13', {
    conflicts: cleanMerge, 'review-r1': floorReview, 'fix-r1': pushingFix, 'final-check': verdict(false),
  })
  assert.match(result.blockedOnHuman[0], /NOT reverted, still on the branch/)
  assert.deepEqual(result.commitShas, ['abc1234'])
})

test('a revert that could not land says the commit is still on the branch', async () => {
  const revert = { summary: 'conflict', revertShas: [], notReverted: [{ sha: 'abc1234', reason: 'later commit depends on it' }], pushed: false }
  const { result } = await runWith('13', {
    conflicts: cleanMerge, 'review-r1': floorReview, 'fix-r1': pushingFix, 'final-check': verdict(false), 'final-revert': revert,
  })
  assert.match(result.blockedOnHuman[0], /NOT reverted, still on the branch/)
})

test('a last round that pushed nothing skips the final check', async () => {
  const { result, calls } = await runWith('13', {
    conflicts: cleanMerge, 'review-r1': floorReview, 'fix-r1': { ...pushingFix, commitShas: [], pushed: false },
  })
  assert.equal(result.status, 'floor-addressed')
  assert.equal(result.finalCheck, null)
  assert.ok(!calls.some((call) => call.label === 'final-check'))
})

test('stopping at maxRounds after a pushing fix still runs the final check', async () => {
  const review = { ...cleanReview, unresolvedCommentsRemaining: 1 }
  const { result, calls } = await runWith({ pr: '13', maxRounds: 1 }, {
    conflicts: cleanMerge, 'review-r1': review, 'fix-r1': pushingFix, 'final-check': verdict(true),
  })
  assert.equal(result.status, 'max-rounds-hit')
  assert.equal(calls.at(-1).label, 'final-check')
  assert.match(calls.find((call) => call.label === 'fix-r1').prompt, /one commit per thread/)
})

test('a fix round before the last one is not told it is last', async () => {
  const review = { ...cleanReview, unresolvedCommentsRemaining: 1 }
  const { calls } = await runWith({ pr: '13', maxRounds: 2 }, {
    conflicts: cleanMerge, 'review-r1': review, 'fix-r1': pushingFix, 're-review-r2': cleanReview,
  })
  assert.doesNotMatch(calls.find((call) => call.label === 'fix-r1').prompt, /LAST round/)
})

test('on GitLab the revert reopens threads through the discussions API', async () => {
  const { calls } = await runWith({ pr: '7', forge: 'gitlab' }, {
    conflicts: cleanMerge, 'review-r1': floorReview, 'fix-r1': pushingFix, 'final-check': verdict(false), 'final-revert': cleanRevert,
  })
  const revertCall = calls.find((call) => call.label === 'final-revert')
  assert.match(revertCall.prompt, /merge_requests\/7\/discussions\/<thread id>" -f resolved=false/)
  assert.match(revertCall.prompt, /mr-address\.md/)
  assert.match(calls.find((call) => call.label === 'final-check').prompt, /merge request !7/)
})
