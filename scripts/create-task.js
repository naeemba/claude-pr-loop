#!/usr/bin/env node
// Add a card to .dashboard/board.json on the repository's main branch and push
// it, without touching the current branch, HEAD, the index, or the working
// tree. Everything goes through git plumbing against a throwaway index, so a
// worktree in the middle of a feature is left exactly as it was.
//
// The write shape matches the Dashboard app's own writer byte for byte
// (`JSON.stringify(board, null, 2)` plus a trailing newline), so the app and
// this script can take turns without either rewriting the whole file.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BOARD_PATH = '.dashboard/board.json';
const DEFAULT_COLUMNS = ['Todo', 'Doing', 'Done'];
const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
const DEFAULT_PRIORITY = 'medium';
const DEFAULT_REMOTE = 'origin';

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  })?.trim() ?? '';
}

function parseArguments(argv) {
  const parsed = { title: '', notes: '', column: '', priority: DEFAULT_PRIORITY, remote: DEFAULT_REMOTE, seed: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--title') parsed.title = argv[++index] ?? '';
    else if (flag === '--notes') parsed.notes = argv[++index] ?? '';
    else if (flag === '--column') parsed.column = argv[++index] ?? '';
    else if (flag === '--priority') parsed.priority = argv[++index] ?? '';
    // Nearly always `origin`. Some repos keep GitHub on `origin` and GitLab on a
    // second remote (`arr`, `gitlab`); there, `origin` files the card against a
    // mirror nobody reads.
    // An empty value means `$GITLAB_REMOTE` never got set: reject it rather than
    // file the card on that mirror and exit 0, looking filed.
    else if (flag === '--remote') {
      parsed.remote = argv[++index] ?? '';
      if (!parsed.remote) throw new Error('--remote needs a remote name');
    }
    else if (flag === '--seed') parsed.seed = true;
    else if (flag === '--dry-run') parsed.dryRun = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!parsed.title.trim()) throw new Error('a --title is required');
  if (!PRIORITIES.includes(parsed.priority)) {
    throw new Error(`--priority must be one of: ${PRIORITIES.join(', ')}`);
  }
  return parsed;
}

// Every function that talks to git takes `remote` as an argument rather than
// reading a module-level one: a call site that misses it is a crash, not a card
// pushed to whichever remote happens to be `origin`.
function mainBranchName(remote) {
  try {
    // The ref is always `<remote>/<branch>`, so slice the prefix off -- a regexp
    // built from the remote name would read a `.` in it as "any character".
    // stderr is muted: "not a symbolic ref" is this branch's normal answer.
    return git(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).slice(remote.length + 1);
  } catch {
    // <remote>/HEAD is not always set; fall back to the usual names.
  }
  for (const candidate of ['main', 'master']) {
    try {
      git(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${candidate}`]);
      return candidate;
    } catch {
      // try the next one
    }
  }
  throw new Error(`cannot work out which branch on ${remote} is the main one`);
}

function emptyBoard() {
  return { columns: DEFAULT_COLUMNS.map((name) => ({ name, cards: [] })) };
}

// A board.json someone hand-edited into a shape the app never writes still
// parses. Repair it here, once, so nothing downstream has to check.
function normalise(board) {
  if (!board || !Array.isArray(board.columns) || board.columns.length === 0) return emptyBoard();
  for (const column of board.columns) {
    if (!Array.isArray(column.cards)) column.cards = [];
  }
  return board;
}

// The board on main is the only source for a normal run. Creating one is a
// separate, rarer job behind --seed: a board that has gone missing from main is
// far more likely to be a bad merge than an invitation to publish whatever
// stale copy happens to sit in this worktree.
function loadBoard(remote, branch, allowSeed) {
  try {
    // stderr is muted: git's own "fatal: ... exists on disk, but not in ..."
    // is this branch's normal answer, not something to show.
    const onMain = git(['show', `${remote}/${branch}:${BOARD_PATH}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    return { board: normalise(JSON.parse(onMain)), seeded: false };
  } catch {
    // no board on main yet
  }
  if (!allowSeed) {
    throw new Error(
      `${remote}/${branch} has no ${BOARD_PATH}. Re-run with --seed to create it there, ` +
      "from this worktree's copy if it has one. Check first that it was not lost in a merge.",
    );
  }
  try {
    const local = fs.readFileSync(path.join(git(['rev-parse', '--show-toplevel']), BOARD_PATH), 'utf8');
    return { board: normalise(JSON.parse(local)), seeded: true };
  } catch {
    return { board: emptyBoard(), seeded: true };
  }
}

function addCard(board, card, columnName) {
  const column = columnName
    ? board.columns.find((entry) => entry.name.toLowerCase() === columnName.toLowerCase())
    : board.columns[0];
  if (!column) {
    const names = board.columns.map((entry) => entry.name).join(', ');
    throw new Error(`no column named "${columnName}" on the board (have: ${names})`);
  }
  column.cards.push(card);
  return column.name;
}

function commitAndPush(remote, branch, contents, message) {
  const blob = git(['hash-object', '-w', '--stdin'], { input: contents });
  const indexFile = path.join(os.tmpdir(), `create-task-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    git(['read-tree', `${remote}/${branch}`], { env });
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},${BOARD_PATH}`], { env });
    const tree = git(['write-tree'], { env });
    const commit = git(['commit-tree', tree, '-p', `${remote}/${branch}`, '-m', message]);
    git(['push', '--quiet', remote, `${commit}:refs/heads/${branch}`], { stdio: ['ignore', 'ignore', 'inherit'] });
    return commit;
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}

function selfCheck() {
  const assert = require('assert');
  const board = normalise({ columns: [{ name: 'Todo', cards: [{ id: 'a', title: 'old' }] }, { name: 'Done' }] });
  assert.equal(addCard(board, { id: 'b', title: 'new' }, ''), 'Todo');
  assert.deepEqual(board.columns[0].cards.map((card) => card.id), ['a', 'b'], 'a new card goes last in the column');
  assert.equal(addCard(board, { id: 'c', title: 'x' }, 'done'), 'Done', 'column names match case-insensitively');
  assert.throws(() => addCard(board, { id: 'd' }, 'Nope'), /no column named/);
  assert.deepEqual(normalise({ note: 'hand-edited' }), emptyBoard(), 'a board with no columns is replaced');
  assert.deepEqual(normalise({ columns: [{ name: 'Todo' }] }).columns[0].cards, [], 'a column with no cards gets one');
  assert.equal(parseArguments(['--title', 'x']).priority, DEFAULT_PRIORITY);
  assert.throws(() => parseArguments(['--title', 'x', '--priority', 'later']), /--priority must be one of/);
  assert.throws(() => parseArguments(['--notes', 'x']), /--title is required/);
  assert.equal(parseArguments(['--title', 'x']).remote, DEFAULT_REMOTE);
  assert.throws(() => parseArguments(['--title', 'x', '--remote', '']), /--remote needs/);
  // The risk --remote carries is not the parser, it is a git call that still
  // says `origin`. This fails if mainBranchName ever ignores the remote it was
  // handed: against a remote that does not exist it must give up naming that
  // remote, not quietly answer for origin.
  assert.throws(() => mainBranchName('no-such-remote'), /no-such-remote/);
  console.log('create-task: all checks passed');
}

function main() {
  if (process.argv.includes('--test')) return selfCheck();
  const options = parseArguments(process.argv.slice(2));
  const remote = options.remote;
  const branch = mainBranchName(remote);

  // Two attempts: someone else pushing to main between our fetch and our push
  // is the one failure worth retrying, and re-reading main fixes it.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    git(['fetch', '--quiet', remote, branch]);
    const { board, seeded } = loadBoard(remote, branch, options.seed);
    const card = {
      id: crypto.randomUUID(),
      title: options.title.trim(),
      notes: options.notes,
      priority: options.priority,
    };
    const columnName = addCard(board, card, options.column);
    const contents = `${JSON.stringify(board, null, 2)}\n`;
    const seedNote = seeded ? ' — board.json created on main from the local copy' : '';

    if (options.dryRun) {
      console.log(contents);
      console.log(`(dry run) would add "${card.title}" to ${columnName} on ${branch}${seedNote}`);
      return;
    }

    try {
      const commit = commitAndPush(remote, branch, contents, `board: add "${card.title}"`);
      console.log(`Added "${card.title}" to ${columnName} on ${branch} (${commit.slice(0, 8)})${seedNote}`);
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

try {
  main();
} catch (error) {
  console.error(`create-task: ${error.message}`);
  process.exit(1);
}
