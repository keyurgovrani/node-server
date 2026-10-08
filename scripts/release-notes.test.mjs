import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  encodeNotes,
  encodeForAsset,
  fitToLimit,
  SHORT_REF_BUDGET,
  DEFAULT_LIMIT,
} from './release-notes.mjs';

const PULL = 'https://github.com/unify-apps/www/pull';
const COMPARE = 'https://github.com/unify-apps/www/compare/uat-05.07.26...uat-09.08.26';

test('DEFAULT_LIMIT keeps a margin under GitHub\'s 125,000-byte cap', () => {
  // Packing fills to whatever limit it is given, so the limit IS the margin.
  // The live evidence only brackets the real cap (124,769 accepted / 125,039
  // rejected); every other test passes an explicit limit, so nothing else
  // notices if this drifts back up into that band.
  assert.equal(DEFAULT_LIMIT, 124000);
  assert.ok(125000 - DEFAULT_LIMIT >= 1000, 'margin under the observed cap');
});

test('SHORT_REF_BUDGET is 450', () => {
  // Tests that exceed 450 URLs size themselves off SHORT_REF_BUDGET, so they
  // float with the constant and can't catch it drifting — only this can.
  assert.equal(SHORT_REF_BUDGET, 450);
});

test('a pull URL under budget becomes a bare #N ref', () => {
  const input = `* fix(carbon): stop popover closing by @vineetchauhan2003 in ${PULL}/25473`;
  assert.equal(
    encodeNotes({ body: input }),
    '* fix(carbon): stop popover closing by @vineetchauhan2003 in #25473',
  );
});

test('a pull URL past budget becomes an explicit markdown link', () => {
  const input = `* fix: a thing by @someone in ${PULL}/25473`;
  assert.equal(
    encodeNotes({ body: input, budget: 0 }),
    `* fix: a thing by @someone in [#25473](${PULL}/25473)`,
  );
});

test('exact budget boundary: first N refs bare, the rest explicit', () => {
  const input = [1, 2, 3].map(number => `* entry ${number} in ${PULL}/${number}`).join('\n');
  const expected = [`* entry 1 in #1`, `* entry 2 in #2`, `* entry 3 in [#3](${PULL}/3)`].join(
    '\n',
  );
  assert.equal(encodeNotes({ body: input, budget: 2 }), expected);
});

test('default budget: first SHORT_REF_BUDGET refs stay bare, the rest become explicit links', () => {
  const total = SHORT_REF_BUDGET + 2;
  const input = Array.from(
    { length: total },
    (unused, index) => `* entry ${index} in ${PULL}/${index}`,
  ).join('\n');
  const expected = Array.from({ length: total }, (unused, index) =>
    index < SHORT_REF_BUDGET
      ? `* entry ${index} in #${index}`
      : `* entry ${index} in [#${index}](${PULL}/${index})`,
  ).join('\n');

  // No explicit `budget` — the only test in the file exercising the real default.
  assert.equal(encodeNotes({ body: input }), expected);
});

test('incidental #N text already in the input reduces the short-ref budget', () => {
  const input = [
    'fix: drop #26008 accessor',
    `* entry 1 by @author in ${PULL}/1`,
    `* entry 2 by @author in ${PULL}/2`,
  ].join('\n');
  const expected = [
    'fix: drop #26008 accessor',
    `* entry 1 by @author in [#1](${PULL}/1)`,
    `* entry 2 by @author in [#2](${PULL}/2)`,
  ].join('\n');

  // budget: 1 minus the pre-existing #26008 leaves 0 short refs to spend —
  // both pull URLs must come out explicit, not just the one past a literal 1.
  assert.equal(encodeNotes({ body: input, budget: 1 }), expected);
});

test('more incidental refs than the budget degrades entirely to explicit links', () => {
  const input = [
    'fix: drop #30001, #30002, #30003 accessors',
    `* entry 1 by @author in ${PULL}/1001`,
    `* entry 2 by @author in ${PULL}/1002`,
  ].join('\n');
  const expected = [
    'fix: drop #30001, #30002, #30003 accessors',
    `* entry 1 by @author in [#1001](${PULL}/1001)`,
    `* entry 2 by @author in [#1002](${PULL}/1002)`,
  ].join('\n');

  // 3 incidental refs against budget 2: pins that over-subscription degrades
  // to all-explicit. Can't tell a floored 0 from an unfloored negative
  // effective budget apart — `seen <= effectiveBudget` is false either way.
  assert.equal(encodeNotes({ body: input, budget: 2 }), expected);
});

test('a contributor line past budget gets an explicit link, same as an entry line', () => {
  const input = `* @ayushkumar1-ui made their first contribution in ${PULL}/25102`;
  assert.equal(
    encodeNotes({ body: input, budget: 0 }),
    `* @ayushkumar1-ui made their first contribution in [#25102](${PULL}/25102)`,
  );
});

test('bot author lines still encode', () => {
  const input = `* chore: sync assets by @sync-assets[bot] in ${PULL}/25456`;
  assert.equal(encodeNotes({ body: input }), '* chore: sync assets by @sync-assets[bot] in #25456');
});

test('a subject containing the literal words " by " and " in " is untouched by the change', () => {
  const input = `* fix: replace foo by bar in baz by @keyurgovrani in ${PULL}/1`;
  assert.equal(
    encodeNotes({ body: input }),
    '* fix: replace foo by bar in baz by @keyurgovrani in #1',
  );
});

test('encodeNotes leaves the Full Changelog compare link untouched', () => {
  const input = `**Full Changelog**: ${COMPARE}`;
  assert.equal(encodeNotes({ body: input }), input);
});

test('encodeForAsset converts the compare link to an explicit range link', () => {
  const input = `**Full Changelog**: ${COMPARE}`;
  assert.equal(
    encodeForAsset(input),
    `**Full Changelog**: [uat-05.07.26...uat-09.08.26](${COMPARE})`,
  );
});

test('encodeForAsset wraps even a single pull URL that would be under any budget', () => {
  const input = `* fix: a thing by @someone in ${PULL}/1`;
  assert.equal(encodeForAsset(input), `* fix: a thing by @someone in [#1](${PULL}/1)`);
});

test('encodeForAsset ignores the budget entirely, past the real default too', () => {
  const input = Array.from(
    { length: 5 },
    (unused, index) => `* entry in ${PULL}/${index}`,
  ).join('\n');
  const result = encodeForAsset(input);
  for (let index = 0; index < 5; index += 1) {
    assert.match(result, new RegExp(`\\[#${index}\\]\\(${PULL}/${index}\\)`));
  }
});

test('passes unmatched lines through verbatim', () => {
  const input = "## What's Changed\n* a hand-written bullet with no author clause\n";
  assert.equal(encodeNotes({ body: input }), input);
  assert.equal(encodeForAsset(input), input);
});

test('encodeNotes is idempotent', () => {
  const once = encodeNotes({ body: `* fix: thing by @a-user in ${PULL}/7`, budget: 0 });
  assert.equal(encodeNotes({ body: once, budget: 0 }), once);
});

test('encodeForAsset is idempotent', () => {
  const once = encodeForAsset(`* fix: thing by @a-user in ${PULL}/7\n**Full Changelog**: ${COMPARE}`);
  assert.equal(encodeForAsset(once), once);
});

function buildNotes({ entryCount, contributorCount = 2, entryWidth = 90 }) {
  // Real pull URLs (not bare #N) so encodeNotes/encodeForAsset have
  // something to actually transform — matches the shape GitHub's generated
  // notes really ship in.
  const entries = Array.from(
    { length: entryCount },
    (unused, index) => `* ${'x'.repeat(entryWidth)} by @author${index} in ${PULL}/${1000 + index}`,
  );
  const contributors = Array.from(
    { length: contributorCount },
    (unused, index) => `* @newbie${index} made their first contribution in ${PULL}/${2000 + index}`,
  );
  return [
    "## What's Changed",
    ...entries,
    '',
    '## New Contributors',
    ...contributors,
    '',
    '**Full Changelog**: https://github.com/unify-apps/www/compare/uat-01.01.26...uat-02.01.26',
  ].join('\n');
}

test('a realistic multi-section document keeps New Contributors explicit once entries exhaust the budget', () => {
  const entryCount = SHORT_REF_BUDGET + 5;
  const body = buildNotes({ entryCount, contributorCount: 5 });
  const result = encodeNotes({ body });

  const entryLines = result.split('\n').filter(line => line.includes(' by @author'));
  const contributorLines = result
    .split('\n')
    .filter(line => line.includes('made their first contribution'));

  // Document order matters: entries render first and spend the whole budget,
  // so the trailing contributors block — last in the real payload too — must
  // fall back to explicit links, not the dead #N refs that caused the
  // original production bug.
  assert.match(entryLines[0], /#1000$/);
  assert.equal(contributorLines.length, 5);
  for (const contributorLine of contributorLines) {
    assert.match(contributorLine, new RegExp(`\\[#\\d+\\]\\(${PULL}/\\d+\\)$`));
  }
});

test('returns the body unchanged when it already fits', () => {
  const body = buildNotes({ entryCount: 10 });
  const result = fitToLimit({ body, tag: 'uat-09.08.26' });

  assert.equal(result.truncated, false);
  assert.equal(result.body, body);
  assert.equal(result.total, 10);
  assert.equal(result.shown, 10);
});

test('truncates over-limit notes while preserving the tail', () => {
  const body = buildNotes({ entryCount: 200 });
  const limit = 5000;
  const result = fitToLimit({ body, tag: 'uat-09.08.26', limit });

  assert.equal(result.truncated, true);
  assert.ok(result.body.length <= limit, `body was ${result.body.length}, limit ${limit}`);
  assert.equal(result.total, 200);
  assert.ok(result.shown > 0 && result.shown < 200);
  assert.match(result.body, /^## What's Changed$/m);
  assert.match(result.body, /> \[!WARNING\]/);
  assert.match(result.body, new RegExp(`Showing ${result.shown} of 200 entries`));
  assert.match(result.body, /release-notes-uat-09\.08\.26\.md/);
  assert.match(result.body, /^## New Contributors$/m);
  assert.match(result.body, /^\*\*Full Changelog\*\*:/m);
});

test('drops the contributors block when the reserved tail alone exceeds the limit', () => {
  const body = buildNotes({ entryCount: 50, contributorCount: 400 });
  const limit = 3000;
  const result = fitToLimit({ body, tag: 'live-09.08.26', limit });

  assert.equal(result.truncated, true);
  assert.ok(result.body.length <= limit, `body was ${result.body.length}, limit ${limit}`);
  assert.ok(!result.body.includes('## New Contributors'));
  assert.match(result.body, /^\*\*Full Changelog\*\*:/m);
});

test('hard-truncates when even the stripped tail exceeds the limit', () => {
  const body = buildNotes({ entryCount: 50, contributorCount: 400 });
  const limit = 250;
  const result = fitToLimit({ body, tag: 'live-09.08.26', limit });

  assert.equal(result.truncated, true);
  assert.ok(result.body.length <= limit, `body was ${result.body.length}, limit ${limit}`);
});

test('clamps a negative limit to an empty body instead of trimming from the end', () => {
  const body = buildNotes({ entryCount: 10 });
  const result = fitToLimit({ body, tag: 'live-09.08.26', limit: -1 });

  assert.equal(result.truncated, true);
  // Math.max(limit, 0) forces the floor slice to width 0 for any negative
  // limit. Without it, slice(0, -1) trims one char off the end instead of
  // capping length, so the body stays almost full size instead of empty.
  assert.equal(result.body, '');
});

test('negative limit clamp still holds when the body carries multi-byte content', () => {
  const body = `## What's Changed\n* fix: em dash — test by @author in ${PULL}/1`;
  const result = fitToLimit({ body, tag: 'live-09.08.26', limit: -5 });

  assert.equal(result.truncated, true);
  assert.equal(result.body, '');
});

test('truncates when byte count exceeds the limit even though char count does not', () => {
  const limit = 60;
  // '—' (em dash) is 1 UTF-16 code unit — `.length` counts it as 1 — but 3
  // UTF-8 bytes. A body of exactly `limit` em dashes reads as "already fits"
  // under a char-based check while its real byte count is 3x over: this is
  // the exact trap that shipped a body GitHub rejected as too long.
  const body = '—'.repeat(limit);
  assert.equal(body.length, limit);
  assert.ok(Buffer.byteLength(body, 'utf8') > limit);

  const result = fitToLimit({ body, tag: 'uat-09.08.26', limit });

  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.body, 'utf8') <= limit);
});

test('returned body byte length never exceeds the limit across multi-byte entries', () => {
  // Real PR titles carry ellipses (…), em dashes (—), and non-ASCII names —
  // mixing all three into every entry compounds the byte/char gap across
  // hundreds of lines, exercising the fill loop's per-line cost accounting
  // rather than just the single up-front check the test above covers.
  const entries = Array.from(
    { length: 300 },
    (unused, index) => `* fix: tidy up thing… — refactor by @日本語user${index} in ${PULL}/${1000 + index}`,
  );
  const body = ["## What's Changed", ...entries, '', `**Full Changelog**: ${COMPARE}`].join('\n');
  const limit = 4000;

  const result = fitToLimit({ body, tag: 'uat-09.08.26', limit });

  assert.equal(result.truncated, true);
  assert.ok(
    Buffer.byteLength(result.body, 'utf8') <= limit,
    `byte length was ${Buffer.byteLength(result.body, 'utf8')}, limit ${limit}`,
  );
});

test('hard-truncation on a multi-byte boundary never leaves a replacement character', () => {
  // The banner text itself contains an em dash ("entries — GitHub"), a 3-byte
  // UTF-8 character sitting at a roughly fixed offset. Sweeping small limits
  // guarantees some of them cut right in the middle of it — the exact case
  // that produces U+FFFD if the byte slice doesn't walk back to a character
  // boundary before decoding.
  const body = buildNotes({ entryCount: 5 });

  for (let limit = 50; limit <= 90; limit += 1) {
    const result = fitToLimit({ body, tag: 'uat-09.08.26', limit });
    assert.equal(result.truncated, true);
    assert.ok(!result.body.includes('\uFFFD'), `limit ${limit} produced a replacement character`);
    assert.ok(
      Buffer.byteLength(result.body, 'utf8') <= limit,
      `limit ${limit}: byte length ${Buffer.byteLength(result.body, 'utf8')} exceeded`,
    );
  }
});

test('a fractional --limit still lands the cut on a clean character boundary', () => {
  // `cut` reaches the hard-slice floor as a raw float when --limit is
  // fractional (e.g. 58.5). `buffer[58.5]` reads undefined, so the
  // continuation-byte walk silently no-ops while Buffer.toString's own
  // integer coercion on `end` still truncates mid-character — Math.trunc(limit)
  // is what keeps the walk running.
  const body = buildNotes({ entryCount: 5 });
  const limit = 58.5;

  const result = fitToLimit({ body, tag: 'uat-09.08.26', limit });

  assert.equal(result.truncated, true);
  assert.ok(!result.body.includes('\uFFFD'));
  assert.ok(Buffer.byteLength(result.body, 'utf8') <= limit);
});

const SCRIPT = fileURLToPath(new URL('./release-notes.mjs', import.meta.url));
const tmpDirs = [];

after(async () => {
  for (const dir of tmpDirs) {
    try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
  }
});

async function makeTmpDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'release-notes-'));
  tmpDirs.push(dir);
  return dir;
}

function runCli({ stdin, args, script = SCRIPT }) {
  return new Promise(resolve => {
    const child = execFile('node', [script, ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

test('CLI writes the compressed body and no asset when it fits', async () => {
  const dir = await makeTmpDir();
  const out = path.join(dir, 'body.md');
  const rawOut = path.join(dir, 'full.md');
  const stdin = `## What's Changed\n* fix: a thing by @someone in ${PULL}/42\n`;

  const { code } = await runCli({
    stdin,
    args: ['--tag', 'uat-09.08.26', '--out', out, '--raw-out', rawOut],
  });

  assert.equal(code, 0);
  assert.match(await fs.readFile(out, 'utf8'), /in #42$/m);
  // the asset must only exist when the notes were truncated
  await assert.rejects(() => fs.access(rawOut));
});

test('CLI writes the raw notes encoded for the asset (no budget) when it truncates', async () => {
  const dir = await makeTmpDir();
  const out = path.join(dir, 'body.md');
  const rawOut = path.join(dir, 'full.md');
  const stdin = buildNotes({ entryCount: 200 });

  const { code } = await runCli({
    stdin,
    args: ['--tag', 'uat-09.08.26', '--out', out, '--raw-out', rawOut, '--limit', '5000'],
  });

  assert.equal(code, 0);
  assert.ok((await fs.readFile(out, 'utf8')).length <= 5000);
  // raw-out must be the download-safe asset encoding, not stdin verbatim —
  // encodeForAsset wraps every entry/contributor pull URL plus the compare
  // URL, so this only holds because buildNotes' fixture carries real URLs.
  assert.equal(await fs.readFile(rawOut, 'utf8'), encodeForAsset(stdin));
});

test('CLI exits 1 on empty stdin', async () => {
  const dir = await makeTmpDir();
  const { code, stderr } = await runCli({
    stdin: '',
    args: ['--tag', 'uat-09.08.26', '--out', path.join(dir, 'body.md')],
  });

  assert.equal(code, 1);
  assert.match(stderr, /empty notes on stdin/);
});

test('CLI rejects a non-numeric --limit', async () => {
  const dir = await makeTmpDir();
  const { code, stderr } = await runCli({
    stdin: '',
    args: ['--tag', 'uat-09.08.26', '--out', path.join(dir, 'body.md'), '--limit', 'abc'],
  });

  assert.equal(code, 1);
  assert.match(stderr, /--limit must be a positive number/);
});

test('CLI rejects a negative --limit', async () => {
  const dir = await makeTmpDir();
  const { code, stderr } = await runCli({
    stdin: '',
    args: ['--tag', 'uat-09.08.26', '--out', path.join(dir, 'body.md'), '--limit', '-100'],
  });

  assert.equal(code, 1);
  assert.match(stderr, /--limit must be a positive number/);
});

// import.meta.url is percent-encoded; process.argv[1] is not. A naive
// `file://${argv[1]}` comparison silently fails to match on a path with a
// space, so main() never runs — node exits 0 having written nothing. Exit
// code alone can't tell the two cases apart (both are 0), so this asserts
// the success log line and the output file actually landed.
test('CLI entrypoint guard matches when the script path contains a space', async () => {
  // os.tmpdir() on macOS is a symlink (/var -> /private/var) that Node's ESM
  // loader resolves in import.meta.url but not in process.argv[1] — a
  // mismatch unrelated to spaces. Resolve the real path first so this test
  // isolates only the space/percent-encoding bug Finding 2 fixes.
  const base = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(base, 'release notes '));
  tmpDirs.push(dir);
  const spacedScript = path.join(dir, 'release-notes.mjs');
  await fs.copyFile(SCRIPT, spacedScript);

  const out = path.join(dir, 'body.md');
  const stdin = `## What's Changed\n* fix: a thing by @someone in ${PULL}/42\n`;

  const { code, stdout } = await runCli({
    stdin,
    args: ['--tag', 'uat-09.08.26', '--out', out],
    script: spacedScript,
  });

  assert.equal(code, 0);
  assert.match(stdout, /release-notes: \d+ → \d+ chars \/ \d+ bytes/);
  assert.match(await fs.readFile(out, 'utf8'), /in #42$/m);
});

// import.meta.url resolves symlinks (Node's ESM loader canonicalises the
// module path); process.argv[1] keeps whatever path was typed on the command
// line. Invoking the script through a symlink reproduces the same class of
// mismatch macOS's `/tmp` -> `/private/tmp` triggers live: the guard must
// still match, or main() silently never runs and the process exits 0 having
// written nothing.
test('CLI entrypoint guard matches when invoked through a symlinked path', async () => {
  const dir = await makeTmpDir();
  const symlinkPath = path.join(dir, 'release-notes-symlink.mjs');
  await fs.symlink(SCRIPT, symlinkPath);

  const out = path.join(dir, 'body.md');
  const stdin = `## What's Changed\n* fix: a thing by @someone in ${PULL}/42\n`;

  const { code, stdout } = await runCli({
    stdin,
    args: ['--tag', 'uat-09.08.26', '--out', out],
    script: symlinkPath,
  });

  assert.equal(code, 0);
  assert.match(stdout, /release-notes: \d+ → \d+ chars \/ \d+ bytes/);
  assert.match(await fs.readFile(out, 'utf8'), /in #42$/m);
});
