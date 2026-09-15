export const meta = {
  name: 'pr-loop',
  description: 'Chained review -> fix -> re-review loop using fresh-context subagents. GitHub PRs or GitLab MRs.',
  whenToUse: 'Triggered by /pr-loop <pr#> or /mr-loop <mr-iid>. Loops review/fix/re-review until convergence or max rounds.',
  phases: [
    { title: 'Round 1: Review', detail: 'Runs /pr-review verbatim in a fresh session' },
    { title: 'Round 1: Re-review', detail: 'Only with startAt: rereview — runs /pr-rereview instead' },
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
// The loop stops re-reviewing once nothing above this severity is left
// unresolved — the remaining tail gets one final fix round with nothing after it
// to check the work, rather than costing a re-review + fix agent pair per round.
// Set `stopAt: 'nit'` to only stop on a fully clean PR; a higher tag sends more,
// and more serious, findings into that unverified final round.
// Must match the scale defined in ~/.claude/review/standard.md, which is the
// source of truth for it; this array is the only copy and must not drift.
const SEVERITY_ORDER = ['nit', 'low', 'medium', 'high', 'blocker']
const STOP_AT = (args && args.stopAt) || 'low'
if (!SEVERITY_ORDER.includes(STOP_AT)) {
  throw new Error(`pr-loop: stopAt must be one of ${SEVERITY_ORDER.join(', ')}`)
}
// Start round 1 on /pr-rereview instead of /pr-review. For a PR whose findings
// were already fixed elsewhere (a second session, a manual pass): round 1 then
// verifies those fixes and resolves their threads rather than reviewing the head
// as if nothing had been addressed.
const START_AT_REREVIEW = Boolean(args && args.startAt === 'rereview')

const COMMANDS_DIR = '~/.claude/commands'

// Same loop, two forges. The rounds, the counts and the convergence rules are
// identical -- only the command files each round executes and the script that
// lists open threads differ, and those differ by one prefix: pr- on GitHub,
// mr- on GitLab. `forge: 'gitlab'` is what /mr-loop passes.
const FORGE_PREFIXES = { github: 'pr', gitlab: 'mr' }
const forgeName = (args && args.forge) || 'github'
const prefix = FORGE_PREFIXES[forgeName]
if (!prefix) {
  throw new Error(`pr-loop: forge must be one of ${Object.keys(FORGE_PREFIXES).join(', ')}`)
}
const FORGE = {
  review: `${prefix}-review.md`,
  rereview: `${prefix}-rereview.md`,
  address: `${prefix}-address.md`,
  threadsScript: `~/.claude/scripts/${prefix}-unresolved-threads.sh`,
}

// Run each round's agent in its own git worktree so the loop never touches the
// branch checked out in the user's working copy.
const ISOLATION = args && args.worktree ? 'worktree' : undefined

const pr = typeof args === 'string'
  ? args.trim()
  : (args && (args.pr || args.mr || args.iid || args.prNumber || args.number))
if (!pr) throw new Error('pr-loop: PR/MR number required as args (string) or args.pr')

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
  required: ['summary', 'commentsPostedThisRound', 'unresolvedCommentsRemaining', 'remainingAtOrBelowFloor', 'blockedOnHuman'],
  properties: {
    summary: { type: 'string', description: '1-3 sentence summary of the review outcome.' },
    commentsPostedThisRound: {
      type: 'integer',
      description: 'Exact number of inline review comments you posted this round. Count every comment you posted; do not classify or filter.',
    },
    unresolvedCommentsRemaining: {
      type: 'integer',
      description: `After finishing, run \`${FORGE.threadsScript} ${pr}\` ONCE inside the repo (it paginates the forge API and prints every unresolved thread, including any you just posted) and report how many threads it printed. Classify every thread from that same output; do not guess from memory of what you posted.`,
    },
    remainingAtOrBelowFloor: {
      type: 'array',
      items: { type: 'string' },
      description: `One line per unresolved thread tagged ${STOP_AT} or below: "path:line — [tag] — what it asks for". A thread with NO severity tag never goes here — a teammate's plain comment is not a nit just because nobody labelled it. This is the final fix round's work list, so it must be specific enough to act on without reopening the PR. Empty array if there are none.`,
    },
    blockedOnHuman: {
      type: 'array',
      items: { type: 'string' },
      description: `One line per unresolved thread that is waiting on a PERSON, not on a code change: raised by a different author, and the most recent comment is a reply from your side, so the ball is in their court. Format: "path:line — who raised it — what it is waiting on". A thread whose last comment is theirs is NOT blocked — it is a finding, and it belongs in the fix round. Each thread appears in at most one list: if it would also qualify for remainingAtOrBelowFloor, put it here instead. Empty array if there are none.`,
    },
  },
}

const FIX_SCHEMA = {
  type: 'object',
  required: ['summary', 'commitShas', 'addressed', 'rejected', 'pushed', 'rejectedThreads'],
  properties: {
    summary: { type: 'string', description: '1-3 sentence summary of fixes applied and pushed. Name any thread you rejected but left open because a different author raised it — those need a human answer.' },
    commitShas: { type: 'array', items: { type: 'string' }, description: 'Short SHAs of commits pushed this round.' },
    addressed: { type: 'integer', description: 'Comments resolved with a code fix + commit-SHA reply THIS round.' },
    rejected: { type: 'integer', description: 'Comments you rejected THIS round — a fresh rejection reply, not one left from an earlier round. A thread you deliberately left alone because you already rejected it does not count; counting it again hides the fact that the round made no progress and keeps the loop spinning.' },
    pushed: { type: 'boolean', description: 'Whether commits were pushed to the PR branch this round.' },
    rejectedThreads: {
      type: 'array',
      items: { type: 'string' },
      description: 'One line per thread you rejected THIS round: "path:line — why you did not fix it". Empty array if you rejected nothing.',
    },
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
If the forge API is temporarily unavailable, retry with backoff before giving up.
`.trim()

// The last fix round is not followed by a re-review, so nothing downstream will
// catch a fix that breaks something. Say so, rather than letting the agent
// assume another round will.
const FINAL_FIX_NOTE = `
This is the LAST round: apart from any thread already waiting on a person, only
threads tagged \`${STOP_AT}\` or below are left, and no re-review follows this
one. Leave the waiting threads alone. Nothing downstream will verify your work,
so keep each fix small and self-evidently correct, and run whatever checks the
repo has before pushing. If a fix would need real restructuring to do safely,
reject it with an explanation instead of half-doing it.
`.trim()

const history = []
let blockedOnHuman = []
// Every exit goes through here, so no status can forget the round history or
// the threads waiting on a person -- the summary reads them off the top level
// instead of digging through history.
const finish = (result) => ({ ...result, blockedOnHuman, history })

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
  const isFirstRound = round === 1 && !START_AT_REREVIEW
  phase(`Round ${round}: ${isFirstRound ? 'Review' : 'Re-review'}`)

  const review = await runAgentWithRetry(
    `${runCommand(isFirstRound ? FORGE.review : FORGE.rereview)}\n\n${reviewSuffix}`,
    { label: isFirstRound ? 'review-r1' : `re-review-r${round}`, schema: REVIEW_SCHEMA, isolation: ISOLATION },
  )
  if (!review) return finish({ status: 'agent-error', stage: 'review', rounds: round })

  // Derived, not self-reported: every unresolved thread is either in the
  // at-or-below-floor list or above the floor (untagged threads never enter the
  // list, so a teammate's unlabelled comment always counts as above). Threads
  // already answered and waiting on a person come out too — no fix round can
  // close one, so leaving it in the count buys a wasted agent pair every round
  // and hides the fact that the code side of the PR is done.
  blockedOnHuman = review.blockedOnHuman
  const aboveFloor =
    review.unresolvedCommentsRemaining - review.remainingAtOrBelowFloor.length - blockedOnHuman.length
  // Negative can only mean one thread was filed under both lists, so it got
  // subtracted twice and a real finding is about to be dropped. Say so.
  if (aboveFloor < 0) {
    log(`Round ${round}: miscount — ${review.remainingAtOrBelowFloor.length} at-or-below-floor + ${blockedOnHuman.length} blocked exceeds ${review.unresolvedCommentsRemaining} unresolved; a thread is in both lists.`)
  }

  history.push({ round, stage: isFirstRound ? 'review' : 're-review', ...review })
  log(
    `Round ${round} review: ${review.summary} | posted=${review.commentsPostedThisRound} unresolved=${review.unresolvedCommentsRemaining} blockedOnHuman=${blockedOnHuman.length} aboveFloor=${aboveFloor}`,
  )

  // Convergence is decided HERE, from counts, not by the reviewer's judgment:
  // no unresolved threads left on the PR. (commentsPostedThisRound alone can't
  // gate this — confirmation replies on resolved threads count as posted.)
  if (review.unresolvedCommentsRemaining === 0) {
    log(`Converged after ${round} review round${round > 1 ? 's' : ''}.`)
    return finish({ status: 'converged', rounds: round })
  }

  // Once only a stopAt-and-below tail is left, this round's fix agent is the
  // last one: it addresses the tail and the loop ends without a re-review. A
  // fix at or below the floor is not worth another review + fix agent pair to verify.
  const isFinalFix = aboveFloor <= 0
  const floorThreads = review.remainingAtOrBelowFloor
  if (isFinalFix) {
    log(`Nothing above \`${STOP_AT}\` left after ${round} round${round > 1 ? 's' : ''}.`)
    if (floorThreads.length === 0) {
      // Nothing a fix round could touch either -- every thread waits on a person.
      log(`Nothing to fix; ${blockedOnHuman.length} waiting on a person.`)
      return finish({ status: 'stopped-at-floor', stopAt: STOP_AT, rounds: round })
    }
    log(`Final fix pass over ${floorThreads.length} thread${floorThreads.length === 1 ? '' : 's'}, then stopping without a re-review.`)
  }

  phase(`Round ${round}: Fix`)
  const fix = await runAgentWithRetry(
    `${runCommand(FORGE.address)}\n\n${fixSuffix}${isFinalFix ? `\n\n${FINAL_FIX_NOTE}` : ''}`,
    { label: `fix-r${round}`, schema: FIX_SCHEMA, isolation: ISOLATION },
  )
  if (!fix) return finish({ status: 'agent-error', stage: 'fix', rounds: round })

  history.push({ round, stage: 'fix', ...fix })
  log(
    `Round ${round} fix: ${fix.summary} | addressed=${fix.addressed} rejected=${fix.rejected} commits=${fix.commitShas.length}`,
  )

  if (isFinalFix) {
    // Carry the fix round's own numbers out: `floorThreads` is what it was ASKED
    // to do, not what it did. Without these, a final round that rejected
    // everything -- or did nothing at all -- reads exactly like one that fixed
    // every thread on the list.
    return finish({
      status: 'floor-addressed',
      stopAt: STOP_AT,
      rounds: round,
      floorThreads,
      addressed: fix.addressed,
      rejected: fix.rejected,
      rejectedThreads: fix.rejectedThreads,
    })
  }

  if (fix.addressed === 0 && fix.rejected === 0) {
    log(`No progress in round ${round} fix. Exiting to avoid infinite loop.`)
    return finish({ status: 'no-progress', rounds: round })
  }
}

log(`Hit MAX_ROUNDS (${MAX_ROUNDS}). Stopping.`)
return finish({ status: 'max-rounds-hit', rounds: MAX_ROUNDS })
