export const meta = {
  name: 'pr-loop',
  description: 'Chained PR review -> fix -> re-review loop using fresh-context subagents.',
  whenToUse: 'Triggered by /pr-loop <pr#>. Loops review/fix/re-review until convergence or max rounds.',
  phases: [
    { title: 'Round 1: Review', detail: 'Runs /pr-review verbatim in a fresh session' },
    { title: 'Round 1: Fix', detail: 'Runs /pr-address verbatim in a fresh session' },
    { title: 'Round 2: Re-review', detail: 'Runs /pr-rereview verbatim in a fresh session' },
    { title: 'Round 2: Fix', detail: 'Runs /pr-address verbatim in a fresh session' },
    { title: 'Round 3: Re-review', detail: 'Runs /pr-rereview verbatim in a fresh session' },
    { title: 'Round 3: Fix', detail: 'Runs /pr-address verbatim in a fresh session' },
    { title: 'Round 4: Re-review', detail: 'Runs /pr-rereview verbatim in a fresh session' },
    { title: 'Round 4: Fix', detail: 'Runs /pr-address verbatim in a fresh session' },
    { title: 'Round 5: Re-review', detail: 'Runs /pr-rereview verbatim in a fresh session' },
    { title: 'Round 5: Fix', detail: 'Runs /pr-address verbatim in a fresh session' },
    { title: 'Round 6: Re-review', detail: 'Runs /pr-rereview verbatim in a fresh session' },
    { title: 'Round 6: Fix', detail: 'Runs /pr-address verbatim in a fresh session' },
  ],
}

const MAX_ROUNDS = (args && args.maxRounds) || 6
// The loop stops once nothing above this severity is left unresolved — the
// remaining low/nit tail is handed back for a manual pass rather than costing a
// re-review + fix agent pair per round. Set `stopAt: 'nit'` to only stop on a
// fully clean PR, or a higher tag to hand back more.
// Must match the scale defined in commands/pr-review.md.
const SEVERITY_ORDER = ['nit', 'low', 'medium', 'high', 'blocker']
const STOP_AT = (args && args.stopAt) || 'low'
if (!SEVERITY_ORDER.includes(STOP_AT)) {
  throw new Error(`pr-loop: stopAt must be one of ${SEVERITY_ORDER.join(', ')}`)
}
const COMMANDS_DIR = '~/.claude/commands'

const pr = typeof args === 'string'
  ? args.trim()
  : (args && (args.pr || args.prNumber || args.number))
if (!pr) throw new Error('pr-loop: PR number required as args (string) or args.pr')

const NO_ATTRIBUTION = `
IMPORTANT: Never mention Claude, Anthropic, or any AI tooling in commits, comments,
PR replies, or any other written artifact. Write as if a human authored the work.
`.trim()

// Each subagent executes the user's actual slash-command file — no paraphrase,
// no extra review taxonomy, no self-judged convergence. The ONLY addition is a
// structured count report at the end, which the script (not the reviewer) uses
// to decide whether the loop continues.
const runCommand = (commandFile) => `
You are a fresh session. The user has invoked the slash command whose definition
lives at ${COMMANDS_DIR}/${commandFile}, with the argument "${pr}".

1. Read ${COMMANDS_DIR}/${commandFile}.
2. Substitute $ARGUMENTS with ${pr}.
3. Execute the command body EXACTLY as written — including any skill it tells you
   to use (invoke that skill via the Skill tool and follow it fully). Add no
   classification the command body does not itself prescribe.

${NO_ATTRIBUTION}
`.trim()

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['summary', 'commentsPostedThisRound', 'unresolvedCommentsRemaining', 'remainingAtOrBelowFloor'],
  properties: {
    summary: { type: 'string', description: '1-3 sentence summary of the review outcome.' },
    commentsPostedThisRound: {
      type: 'integer',
      description: 'Exact number of inline review comments you posted this round. Count every comment you posted; do not classify or filter.',
    },
    unresolvedCommentsRemaining: {
      type: 'integer',
      description: `After finishing, run \`~/.claude/scripts/pr-unresolved-threads.sh ${pr}\` ONCE inside the repo (it paginates GraphQL reviewThreads and prints every thread with isResolved == false, including any you just posted) and report how many threads it printed. Classify every thread from that same output; do not guess from memory of what you posted.`,
    },
    remainingAtOrBelowFloor: {
      type: 'array',
      items: { type: 'string' },
      description: `One line per unresolved thread tagged ${STOP_AT} or below: "path:line — [tag] — what it asks for". A thread with NO severity tag never goes here — a teammate's plain comment is not a nit just because nobody labelled it. This is the hand-back list for a manual pass, so it must be specific enough to act on without reopening the PR. Empty array if there are none.`,
    },
  },
}

const FIX_SCHEMA = {
  type: 'object',
  required: ['summary', 'commitShas', 'addressed', 'rejected', 'pushed'],
  properties: {
    summary: { type: 'string', description: '1-3 sentence summary of fixes applied and pushed. Name any thread you rejected but left open because a different author raised it — those need a human answer.' },
    commitShas: { type: 'array', items: { type: 'string' }, description: 'Short SHAs of commits pushed this round.' },
    addressed: { type: 'integer', description: 'Comments resolved with a code fix + commit-SHA reply THIS round.' },
    rejected: { type: 'integer', description: 'Comments you rejected THIS round — a fresh rejection reply, not one left from an earlier round. A thread you deliberately left alone because you already rejected it does not count; counting it again hides the fact that the round made no progress and keeps the loop spinning.' },
    pushed: { type: 'boolean', description: 'Whether commits were pushed to the PR branch this round.' },
  },
}

const reviewSuffix = `
After the command is fully executed, return a structured result via the
StructuredOutput tool with the exact counts described in the schema. Apply the
command's severity scale exactly as it defines it; do not invent your own tags.
These are raw counts for loop control — do not decide yourself whether the PR is
"clear", and never adjust a severity tag to change what the loop does next.
`.trim()

const fixSuffix = `
After the command is fully executed, ensure any commits are pushed to the PR
branch, then return a structured result via the StructuredOutput tool.
If the GitHub API is temporarily unavailable, retry with backoff before giving up.
`.trim()

const history = []

// agent() returns null on a terminal API error (e.g. 529) and THROWS when the
// subagent ends its turn without calling StructuredOutput (it happens when the
// subagent parks work in a background child and stops to wait). Both are
// transient — treat them the same and retry up to twice.
const RETRY_CAUTION = `
NOTE: a previous attempt at this exact task may have already done part of the
work (posted comments, pushed commits) before failing to report. Check what
already exists first and only do what is missing — never post or push the same
thing twice.
`.trim()

const runAgentWithRetry = async (prompt, options) => {
  const labels = [options.label, `${options.label}-retry`, `${options.label}-retry2`]
  for (const [attempt, label] of labels.entries()) {
    const attemptPrompt = attempt === 0 ? prompt : `${prompt}\n\n${RETRY_CAUTION}`
    try {
      const result = await agent(attemptPrompt, { ...options, label })
      if (result) return result
      log(`${label} returned null (API error?), retrying...`)
    } catch (error) {
      log(`${label} threw (${String(error).slice(0, 120)}), retrying...`)
    }
  }
  return null
}

for (let round = 1; round <= MAX_ROUNDS; round++) {
  const isFirstRound = round === 1
  phase(`Round ${round}: ${isFirstRound ? 'Review' : 'Re-review'}`)

  const review = await runAgentWithRetry(
    `${runCommand(isFirstRound ? 'pr-review.md' : 'pr-rereview.md')}\n\n${reviewSuffix}`,
    { label: isFirstRound ? 'review-r1' : `re-review-r${round}`, schema: REVIEW_SCHEMA },
  )
  if (!review) return { status: 'agent-error', stage: 'review', rounds: round, history }

  // Derived, not self-reported: every unresolved thread is either in the
  // at-or-below-floor list or above the floor (untagged threads never enter the
  // list, so a teammate's unlabelled comment always counts as above).
  const aboveFloor = review.unresolvedCommentsRemaining - review.remainingAtOrBelowFloor.length

  history.push({ round, stage: isFirstRound ? 'review' : 're-review', ...review })
  log(
    `Round ${round} review: ${review.summary} | posted=${review.commentsPostedThisRound} unresolved=${review.unresolvedCommentsRemaining} aboveFloor=${aboveFloor}`,
  )

  // Convergence is decided HERE, from counts, not by the reviewer's judgment:
  // no unresolved threads left on the PR. (commentsPostedThisRound alone can't
  // gate this — confirmation replies on resolved threads count as posted.)
  if (review.unresolvedCommentsRemaining === 0) {
    log(`Converged after ${round} review round${round > 1 ? 's' : ''}.`)
    return { status: 'converged', rounds: round, history }
  }

  // Stop before spawning the fix agent once only a stopAt-and-below tail is
  // left: those get a manual pass instead of another re-review + fix pair.
  if (aboveFloor <= 0) {
    const remaining = review.remainingAtOrBelowFloor
    log(`Nothing above \`${STOP_AT}\` left after ${round} round${round > 1 ? 's' : ''}. Handing back ${remaining.length} thread${remaining.length === 1 ? '' : 's'}.`)
    return { status: 'stopped-at-floor', stopAt: STOP_AT, rounds: round, handBack: remaining, history }
  }

  phase(`Round ${round}: Fix`)
  const fix = await runAgentWithRetry(
    `${runCommand('pr-address.md')}\n\n${fixSuffix}`,
    { label: `fix-r${round}`, schema: FIX_SCHEMA },
  )
  if (!fix) return { status: 'agent-error', stage: 'fix', rounds: round, history }

  history.push({ round, stage: 'fix', ...fix })
  log(
    `Round ${round} fix: ${fix.summary} | addressed=${fix.addressed} rejected=${fix.rejected} commits=${fix.commitShas.length}`,
  )

  if (fix.addressed === 0 && fix.rejected === 0) {
    log(`No progress in round ${round} fix. Exiting to avoid infinite loop.`)
    return { status: 'no-progress', rounds: round, history }
  }
}

log(`Hit MAX_ROUNDS (${MAX_ROUNDS}). Stopping.`)
return { status: 'max-rounds-hit', rounds: MAX_ROUNDS, history }
