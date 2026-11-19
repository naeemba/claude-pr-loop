export const meta = {
  name: 'pr-loop',
  description: 'Chained review -> fix -> re-review loop using fresh-context subagents. GitHub PRs or GitLab MRs.',
  whenToUse: 'Triggered by /pr-loop <pr#> or /mr-loop <mr-iid>. Loops review/fix/re-review until convergence or max rounds.',
  // `meta` must be a pure literal, so these `model` values are the defaults
  // only — they cannot read reviewModel/fixModel/conflictsModel and go stale
  // the moment a call overrides one. `runAgentWithRetry` logs the model and
  // effort it actually used for each round; treat these as documentation, not
  // truth.
  phases: [
    { title: 'Conflicts', detail: 'Runs /pr-conflicts verbatim in a fresh session', model: 'inherit' },
    { title: 'Round 1: Review', detail: 'Runs /pr-review verbatim in a fresh session', model: 'opus' },
    { title: 'Round 1: Re-review', detail: 'Only with startAt: rereview — runs /pr-rereview instead', model: 'opus' },
    { title: 'Round 1: Fix', detail: 'Runs /pr-address verbatim in a fresh session', model: 'inherit' },
    { title: 'Round 2: Re-review', detail: 'Runs /pr-rereview verbatim in a fresh session', model: 'opus' },
    { title: 'Round 2: Fix', detail: 'Runs /pr-address verbatim in a fresh session', model: 'inherit' },
    { title: 'Round 3: Re-review', detail: 'Runs /pr-rereview verbatim in a fresh session', model: 'opus' },
    { title: 'Round 3: Fix', detail: 'Runs /pr-address verbatim in a fresh session', model: 'inherit' },
    { title: 'Round 4: Re-review', detail: 'Runs /pr-rereview verbatim in a fresh session', model: 'opus' },
    { title: 'Round 4: Fix', detail: 'Runs /pr-address verbatim in a fresh session', model: 'inherit' },
    { title: 'Round 5: Re-review', detail: 'Runs /pr-rereview verbatim in a fresh session', model: 'opus' },
    { title: 'Round 5: Fix', detail: 'Runs /pr-address verbatim in a fresh session', model: 'inherit' },
    { title: 'Round 6: Re-review', detail: 'Runs /pr-rereview verbatim in a fresh session', model: 'opus' },
    { title: 'Round 6: Fix', detail: 'Runs /pr-address verbatim in a fresh session', model: 'inherit' },
    { title: 'Final check', detail: 'Checks only the last fix round\'s commits; never fixes', model: 'opus' },
    { title: 'Final check: Revert', detail: 'Only when the check rejects a commit — git revert, reopen its threads', model: 'inherit' },
  ],
}

// `in` throws on a string, and args is the bare PR number for a plain
// `/pr-loop 57` — so the arguments object has to be narrowed before any lookup.
// Every option below reads off this narrowed form, not off the raw `args`.
const workflowArguments = args && typeof args === 'object' ? args : {}

const MAX_ROUNDS = workflowArguments.maxRounds || 6
// The loop stops re-reviewing once nothing above this severity is left
// unresolved — the remaining tail gets one final fix round and a check-only pass
// over its commits, rather than costing a re-review + fix agent pair per round.
// Set `stopAt: 'nit'` to only stop on a fully clean PR; a higher tag sends
// more, and more serious, findings into that final round, which gets only a
// check-only pass.
// Must match the scale defined in ~/.claude/review/standard.md, which is the
// source of truth for it; this array is the only copy and must not drift.
const SEVERITY_ORDER = ['nit', 'low', 'medium', 'high', 'blocker']
const STOP_AT = workflowArguments.stopAt || 'low'
if (!SEVERITY_ORDER.includes(STOP_AT)) {
  throw new Error(`pr-loop: stopAt must be one of ${SEVERITY_ORDER.join(', ')}`)
}
// Start round 1 on /pr-rereview instead of /pr-review. For a PR whose findings
// were already fixed elsewhere (a second session, a manual pass): round 1 then
// verifies those fixes and resolves their threads rather than reviewing the head
// as if nothing had been addressed.
const START_AT_REREVIEW = workflowArguments.startAt === 'rereview'

const COMMANDS_DIR = '~/.claude/commands'

// A bare `/pr-loop 622` sometimes arrives as the number 622, not the string.
const pr = typeof args === 'string' || typeof args === 'number'
  ? String(args).trim()
  : (workflowArguments.pr || workflowArguments.mr || workflowArguments.iid || workflowArguments.prNumber || workflowArguments.number)
if (!pr) throw new Error('pr-loop: PR/MR number required as args (string or number) or args.pr')

// Same loop, two forges. The rounds, the counts and the convergence rules are
// identical -- only the command files each round executes, the script that
// lists open threads, what the change is called and how the final check's
// revert reopens a thread differ. The files differ by one prefix: pr- on
// GitHub, mr- on GitLab. `forge: 'gitlab'` is what /mr-loop passes.
const FORGES = {
  github: {
    prefix: 'pr',
    noun: `PR #${pr}`,
    reopenCommand: `gh api graphql -f query='mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<thread id>`,
  },
  gitlab: {
    prefix: 'mr',
    noun: `merge request !${pr}`,
    reopenCommand: `eval "$(~/.claude/scripts/gitlab-remote.sh)" && glab api --method PUT "projects/$GITLAB_PROJECT/merge_requests/${pr}/discussions/<thread id>" -f resolved=false`,
  },
}
const forgeName = workflowArguments.forge || 'github'
if (!(forgeName in FORGES)) {
  throw new Error(`pr-loop: forge must be one of ${Object.keys(FORGES).join(', ')}`)
}
const { prefix, noun, reopenCommand } = FORGES[forgeName]
const FORGE = {
  noun,
  reopenCommand,
  review: `${prefix}-review.md`,
  rereview: `${prefix}-rereview.md`,
  address: `${prefix}-address.md`,
  conflicts: `${prefix}-conflicts.md`,
  threadsScript: `~/.claude/scripts/${prefix}-unresolved-threads.sh`,
}

// Run each round's agent in its own git worktree so the loop never touches the
// branch checked out in the user's working copy.
const ISOLATION = workflowArguments.worktree ? 'worktree' : undefined

// Review rounds pin opus at high effort so starting the loop from a cheaper
// session cannot quietly downgrade the only thing deciding what is wrong with
// the code. Fix and conflicts default to `inherit` — same model/effort as the
// session that typed `/pr-loop` — because applying a review decision and
// merging the base are judgment calls that benefit from the session's strength,
// and pinning sonnet was downgrading them when the session ran a stronger model. Pass
// `reviewModel`/`fixModel`/`conflictsModel` to override; pass `null` (JSON has
// no `undefined`), `"session"` or `"inherit"` for any of them to put that
// round's model AND effort back on the session's instead of a pinned pair.
// Review defaults still mirror pr-review.md/pr-rereview.md (opus/high). Fix and
// conflicts intentionally do NOT mirror pr-address.md/pr-conflicts.md
// frontmatter (still sonnet for standalone `/pr-address` / `/pr-conflicts`).
const SESSION_MODEL_VALUES = [null, 'session', 'inherit']
const KNOWN_MODELS = ['haiku', 'sonnet', 'opus', 'fable']
const isValidModelArgument = (value) =>
  SESSION_MODEL_VALUES.includes(value) || KNOWN_MODELS.includes(value) || (typeof value === 'string' && value.includes('-'))
const readModelArgument = (key, fallback) => {
  const value = key in workflowArguments ? workflowArguments[key] : fallback
  if (!isValidModelArgument(value)) {
    throw new Error(`pr-loop: ${key} must be null, "session", "inherit", one of ${KNOWN_MODELS.join(', ')}, or a full model ID`)
  }
  return value
}
const REVIEW_MODEL = readModelArgument('reviewModel', 'opus')
const FIX_MODEL = readModelArgument('fixModel', 'inherit')
const CONFLICTS_MODEL = readModelArgument('conflictsModel', 'inherit')

// `null`, `"session"` and `"inherit"` all mean "this round is the session's":
// build the agent options with no `model` or `effort` key at all, rather than
// passing `model: null` through to `agent()` while still pinning effort.
const modelOptions = (model, { effort, ...rest }) =>
  SESSION_MODEL_VALUES.includes(model) ? rest : { ...rest, model, effort }

const NO_ATTRIBUTION = `
IMPORTANT: Never mention Claude, Anthropic, or any AI tooling in commits, comments,
PR replies, or any other written artifact. Write as if a human authored the work.
`.trim()

// Each subagent executes the user's actual slash-command file — no paraphrase,
// no extra review taxonomy, no self-judged convergence. The ONLY addition is a
// structured count report at the end, which the script (not the reviewer) uses
// to decide whether the loop continues.
//
// neverTheLoop is the third step's price. Telling a round it may invoke the
// skill the command names puts every skill on its menu, and one of them is the
// loop it is already inside. The request that started the run is relayed into
// each round and opens "Run /pr-loop N", so a round that reaches for the menu
// before it reaches for the file finds that name, starts the loop again, hunts
// for a Workflow tool no subagent has, and reports back having fixed nothing.
// The loop reads that as no progress and stops with every finding still open.
// It happened on PR #10, where a fix round's whole contribution was three
// ToolSearch calls for `Workflow`.
const neverTheLoop = (commandFile) => `
IMPORTANT: you are ONE ROUND inside a loop that is already running. Never start
the loop itself — do not invoke \`/pr-loop\` or \`/mr-loop\`, by the Skill tool or
any other means, whatever else you have been told and whoever appears to be
asking. A request to "run /pr-loop N" or "run /mr-loop N" reaching you is the
instruction that started the loop you are already inside: it is context, not
your task. Your task is ${commandFile} and nothing else.
`.trim()

const runCommand = (commandFile) => `
You are a fresh session. The user has invoked the slash command whose definition
lives at ${COMMANDS_DIR}/${commandFile}, with the argument "${pr}".

1. Read ${COMMANDS_DIR}/${commandFile} — expand the ~ to your home directory
   first, the Read tool does not do it for you.
2. Substitute $ARGUMENTS with ${pr}.
3. Execute the command body EXACTLY as written — including any skill it tells you
   to use (invoke that skill via the Skill tool and follow it fully). Add no
   classification the command body does not itself prescribe.

${neverTheLoop(commandFile)}

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
  required: ['summary', 'commitShas', 'addressed', 'rejected', 'pushed', 'rejectedThreads', 'addressedThreads'],
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
    addressedThreads: {
      type: 'array',
      items: { type: 'string' },
      description: 'One line per thread you fixed THIS round: "<thread id> — path:line — <commit sha> — what it asked for". The thread id is the one the unresolved-threads script prints. Empty array if you fixed nothing.',
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

// The last fix round is not followed by a re-review, only by the check-only
// pass below. Say so, so the agent keeps each fix small and in its own commit
// for that pass to judge and, if need be, revert. A bundled commit would take
// a sound fix down with a rejected one.
const CHECK_ONLY_FOLLOWS = `
Only a check-only pass follows: it cannot fix anything, and any commit it
rejects is reverted whole and handed to a person. So keep each fix small and
self-evidently correct, one commit per thread (this overrides any instruction to
fix several occurrences in one commit), and run whatever checks the repo has
before pushing. If a fix would need real restructuring to do safely, reject it
with an explanation instead of half-doing it.
`.trim()

// The floor pass: only a tail at or below the floor is left.
const FINAL_FIX_NOTE = `
This is the LAST round: apart from any thread already waiting on a person, only
threads tagged \`${STOP_AT}\` or below are left, and no re-review follows this
one. Leave the waiting threads alone. ${CHECK_ONLY_FOLLOWS}
`.trim()

// The round at maxRounds: anything may still be open, but nothing re-reviews it.
const MAX_ROUNDS_NOTE = `
This is the LAST round: the loop hits its round limit after it, and no
re-review follows. ${CHECK_ONLY_FOLLOWS}
`.trim()

// Counts per agent, not the agent's whole report. The result arrives as a task
// notification, and a long one gets cut short, which sends the parent session
// digging through task output files to find out what happened. The summaries
// are already in the log.
const history = []
const commitShas = []
let blockedOnHuman = []

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
  log(`${options.label}: model=${options.model || 'session'} effort=${options.effort || 'session'}`)
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

// Conflicts are settled before the first review, so the merge commit is part of
// what the rounds review and fix, instead of landing unreviewed after them. One
// agent runs the conflicts command, which checks and, if the forge says
// conflicting, merges the base in.
const CONFLICT_SCHEMA = {
  type: 'object',
  required: ['summary', 'hadConflicts', 'resolved', 'files', 'checks'],
  properties: {
    summary: { type: 'string', description: '1-3 sentences. If you left a conflict open, say what the two sides disagree about and who should decide.' },
    hadConflicts: { type: ['boolean', 'null'], description: 'Whether the forge reported the branch as conflicting with its target branch. null when the forge never answered — still computing after the retries. Never false for that: false claims the branch merges cleanly.' },
    resolved: { type: 'boolean', description: 'Whether the conflicts are resolved and the merge is pushed. False when there was nothing to resolve, and false when you aborted rather than guess.' },
    files: {
      type: 'array',
      items: { type: 'string' },
      description: 'One line per conflicted file: "path — how you resolved it". Empty array if there were no conflicts.',
    },
    checks: { type: 'string', description: 'The repo checks you ran after merging and their outcome, or why the repo has none. Empty string if you pushed nothing.' },
  },
}

const resolveConflicts = async () => {
  phase('Conflicts')
  const result = await runAgentWithRetry(runCommand(FORGE.conflicts), modelOptions(CONFLICTS_MODEL, {
    label: 'conflicts',
    schema: CONFLICT_SCHEMA,
    isolation: ISOLATION,
    effort: 'low',
  }))
  if (!result) return null
  log(
    `Conflicts: ${result.summary} | hadConflicts=${result.hadConflicts} resolved=${result.resolved} files=${result.files.length}`,
  )
  return result
}

// Every exit goes through here, so no status can forget the round history, the
// commits pushed or the threads waiting on a person. An `agent-error` exit
// still says what earlier rounds pushed, so the run never ends with fixes on
// the branch and no word of them.
const finish = (result) => ({ ...result, blockedOnHuman, commitShas, history })

// The last fix round has no re-review behind it, whether the run stopped at the
// floor or at maxRounds. One check-only agent reads just that round's commits.
// It cannot fix, so it cannot start another round that would itself need
// checking: a rejected commit is reverted, its threads reopened, and a person
// takes it from there.

const CHECK_SCHEMA = {
  type: 'object',
  required: ['summary', 'verdicts'],
  properties: {
    summary: { type: 'string', description: '1-3 sentence summary of the check.' },
    verdicts: {
      type: 'array',
      description: 'Exactly one entry per commit you were given.',
      items: {
        type: 'object',
        required: ['sha', 'accepted', 'threads', 'reason'],
        properties: {
          sha: { type: 'string' },
          accepted: { type: 'boolean' },
          threads: { type: 'array', items: { type: 'string' }, description: 'The given thread lines this commit answers, copied verbatim.' },
          reason: { type: 'string', description: 'Why. On a rejection, the concrete failure: what breaks, what behaviour changed beyond the finding, or what is still unfixed.' },
        },
      },
    },
  },
}

const REVERT_SCHEMA = {
  type: 'object',
  required: ['summary', 'revertShas', 'notReverted', 'pushed'],
  properties: {
    summary: { type: 'string', description: '1-3 sentence summary.' },
    revertShas: { type: 'array', items: { type: 'string' }, description: 'Short SHAs of the revert commits you pushed.' },
    notReverted: {
      type: 'array',
      description: 'One entry per rejected commit you could NOT revert. Empty array if every revert landed.',
      items: {
        type: 'object',
        required: ['sha', 'reason'],
        properties: { sha: { type: 'string', description: 'The SHA exactly as you were given it.' }, reason: { type: 'string' } },
      },
    },
    pushed: { type: 'boolean' },
  },
}

const checkPrompt = (fix) => `
You are a fresh session doing ONE check-only pass on ${FORGE.noun}, after the
review loop's last fix round. No review round follows you, and you never fix:
no edits, no commits, no pushes, no replies, no resolving or reopening threads.

The last fix round pushed these commits:
${fix.commitShas.map((sha) => `- ${sha}`).join('\n')}

It reports fixing these threads ("<thread id> — path:line — sha — what it asked for"):
${fix.addressedThreads.length ? fix.addressedThreads.map((line) => `- ${line}`).join('\n') : '- (none reported)'}

For each commit: fetch it and read \`git show <sha>\`. Its thread line above is
the finding; open the thread itself (\`${FORGE.threadsScript} ${pr}\`) only when
the line is not enough to judge. Run whatever checks the repo has (tests,
type-check, lint) on the head. Then judge it:
- accept: it fixes what its thread asked, changes nothing beyond that, and
  breaks nothing.
- reject: it breaks something, changes behaviour beyond what the finding asked,
  or does not fix the finding. A commit that answers no listed thread changes
  behaviour beyond any finding.
Reject only for a concrete failure you can name. A different way you would have
written it is not one. Check only these commits; anything else on the branch is
not yours to judge.

${neverTheLoop('this check and nothing else')}

${NO_ATTRIBUTION}

Return the verdicts via the StructuredOutput tool.
`.trim()

const revertPrompt = (rejected) => `
You are a fresh session. The review loop's final check on ${FORGE.noun} rejected
these commits from its last fix round:
${rejected.map((verdict) => `- ${verdict.sha} — ${verdict.reason}\n  threads: ${verdict.threads.join('; ') || '(none)'}`).join('\n')}

Undo them, and fix nothing:
1. Bring the checkout to the latest head of the branch — fetch it from the
   remote the push section of ${COMMANDS_DIR}/${FORGE.address} pushes to (expand
   the ~ first).
2. Revert each commit, newest first, with \`git revert --no-edit <sha>\`. Never
   reset, rebase, amend or force-push. If a revert conflicts, run
   \`git revert --abort\`, leave that commit in place and list it in notReverted.
3. Run whatever checks the repo has, then push exactly as that push section says.
4. On each listed thread, reply saying the fix was rejected by the final check,
   why, and which revert commit undid it (or that it could not be undone), and
   that it needs a person. Reply the way ${FORGE.address} replies. If the thread
   is resolved, reopen it:
   \`${FORGE.reopenCommand}\`

${neverTheLoop('this revert and nothing else')}

${NO_ATTRIBUTION}

Return the result via the StructuredOutput tool.
`.trim()

// Short and full SHAs of one commit name it equally.
const sameCommit = (one, other) => one.startsWith(other) || other.startsWith(one)

// Returns null when the last round pushed nothing, so there is nothing to check.
const checkLastFix = async (fix) => {
  if (!fix?.commitShas.length) return null
  phase('Final check')
  const check = await runAgentWithRetry(checkPrompt(fix), modelOptions(REVIEW_MODEL, {
    label: 'final-check',
    schema: CHECK_SCHEMA,
    isolation: ISOLATION,
    effort: 'high',
  }))
  if (!check) {
    log('Final check failed; the last fix round\'s commits stay unverified.')
    return { checked: fix.commitShas, verdicts: null }
  }
  // Match verdicts to the round's commits: a verdict on any other sha is
  // dropped, never handed to the revert, and a commit with no verdict was never
  // judged, so it is unverified, not accepted.
  const inRound = (sha) => fix.commitShas.some((roundSha) => sameCommit(roundSha, sha))
  const verdicts = check.verdicts.filter((verdict) => inRound(verdict.sha))
  const unverified = fix.commitShas.filter((sha) => !verdicts.some((verdict) => sameCommit(verdict.sha, sha)))
  const rejected = verdicts.filter((verdict) => !verdict.accepted)
  const accepted = verdicts.length - rejected.length
  history.push({ round: fix.round, stage: 'final-check', accepted, rejected: rejected.length, unverified: unverified.length })
  log(`Final check: ${check.summary} | accepted=${accepted} rejected=${rejected.length} unverified=${unverified.length}`)
  // Shas only: the reasons are in blockedOnHuman, one line per thread.
  const outcome = { checked: fix.commitShas, rejected: rejected.map((verdict) => verdict.sha), unverified }
  if (!rejected.length) return outcome

  phase('Final check: Revert')
  const revert = await runAgentWithRetry(revertPrompt(rejected), modelOptions(FIX_MODEL, {
    label: 'final-revert',
    schema: REVERT_SCHEMA,
    isolation: ISOLATION,
    effort: 'low',
  }))
  // A revert that never reached the remote undid nothing.
  const pushed = revert?.pushed === true
  if (pushed) commitShas.push(...revert.revertShas)
  const undone = (sha) => pushed && !revert.notReverted.some((entry) => sameCommit(entry.sha, sha))
  blockedOnHuman = [
    ...blockedOnHuman,
    ...rejected.flatMap((verdict) => (verdict.threads.length ? verdict.threads : [`(no thread) — ${verdict.sha}`]).map(
      (thread) => `${thread} — fix ${verdict.sha} rejected by the final check, ${undone(verdict.sha) ? 'reverted' : 'NOT reverted, still on the branch'} — ${verdict.reason}`,
    )),
  ]
  return {
    ...outcome,
    reverted: pushed ? revert.revertShas : [],
    notReverted: outcome.rejected.filter((sha) => !undone(sha)),
  }
}

const lastRoundNote = (isFinalFix, round) => {
  if (isFinalFix) return `\n\n${FINAL_FIX_NOTE}`
  return round === MAX_ROUNDS ? `\n\n${MAX_ROUNDS_NOTE}` : ''
}

// The exits that end on a fix return it as `lastFix`, for the final check.
const runLoop = async () => {
  let lastFix = null
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const isFirstRound = round === 1 && !START_AT_REREVIEW
    phase(`Round ${round}: ${isFirstRound ? 'Review' : 'Re-review'}`)

    const review = await runAgentWithRetry(
      `${runCommand(isFirstRound ? FORGE.review : FORGE.rereview)}\n\n${reviewSuffix}`,
      modelOptions(REVIEW_MODEL, {
        label: isFirstRound ? 'review-r1' : `re-review-r${round}`,
        schema: REVIEW_SCHEMA,
        isolation: ISOLATION,
        effort: 'high',
      }),
    )
    if (!review) return { status: 'agent-error', stage: 'review', rounds: round }

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

    history.push({
      round,
      stage: isFirstRound ? 'review' : 're-review',
      posted: review.commentsPostedThisRound,
      unresolved: review.unresolvedCommentsRemaining,
      aboveFloor,
    })
    log(
      `Round ${round} review: ${review.summary} | posted=${review.commentsPostedThisRound} unresolved=${review.unresolvedCommentsRemaining} blockedOnHuman=${blockedOnHuman.length} aboveFloor=${aboveFloor}`,
    )

    // Convergence is decided HERE, from counts, not by the reviewer's judgment:
    // no unresolved threads left on the PR. (commentsPostedThisRound alone can't
    // gate this — confirmation replies on resolved threads count as posted.)
    if (review.unresolvedCommentsRemaining === 0) {
      log(`Converged after ${round} review round${round > 1 ? 's' : ''}.`)
      return { status: 'converged', rounds: round }
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
        return { status: 'stopped-at-floor', stopAt: STOP_AT, rounds: round }
      }
      log(`Final fix pass over ${floorThreads.length} thread${floorThreads.length === 1 ? '' : 's'}, then stopping without a re-review.`)
    }

    phase(`Round ${round}: Fix`)
    const fix = await runAgentWithRetry(
      `${runCommand(FORGE.address)}\n\n${fixSuffix}${lastRoundNote(isFinalFix, round)}`,
      modelOptions(FIX_MODEL, { label: `fix-r${round}`, schema: FIX_SCHEMA, isolation: ISOLATION, effort: 'low' }),
    )
    if (!fix) return { status: 'agent-error', stage: 'fix', rounds: round }

    commitShas.push(...fix.commitShas)
    lastFix = { round, ...fix }
    history.push({
      round,
      stage: 'fix',
      addressed: fix.addressed,
      rejected: fix.rejected,
      commits: fix.commitShas.length,
      rejectedThreads: fix.rejectedThreads,
    })
    log(
      `Round ${round} fix: ${fix.summary} | addressed=${fix.addressed} rejected=${fix.rejected} commits=${fix.commitShas.length}`,
    )

    if (isFinalFix) {
      // `floorThreads` is what the final round was ASKED to do. What it actually
      // did (addressed, rejected, rejectedThreads) is the last `history` entry,
      // kept in one place so the result does not carry the list twice.
      return { status: 'floor-addressed', stopAt: STOP_AT, rounds: round, floorThreads, lastFix }
    }

    if (fix.addressed === 0 && fix.rejected === 0) {
      log(`No progress in round ${round} fix. Exiting to avoid infinite loop.`)
      return { status: 'no-progress', rounds: round, lastFix }
    }
  }

  log(`Hit MAX_ROUNDS (${MAX_ROUNDS}). Stopping.`)
  return { status: 'max-rounds-hit', rounds: MAX_ROUNDS, lastFix }
}

const conflicts = await resolveConflicts()
// A conflict left open means a person has to pick a side. Reviewing now would
// review code that is about to change, so stop and hand it over.
if (conflicts?.hadConflicts && !conflicts.resolved) {
  return finish({ status: 'conflicts-unresolved', rounds: 0, conflicts })
}
const { lastFix, ...outcome } = await runLoop()
const finalCheck = await checkLastFix(lastFix)
return finish({ ...outcome, finalCheck, conflicts })
