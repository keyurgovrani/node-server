#!/usr/bin/env node
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// GitHub resolves only ~500 `#N` refs per rendered document, in document
// order, then leaves the rest as dead text. That cap counts every #N GitHub
// sees, including ones already sitting in a PR/commit subject we never touch
// (e.g. "fix: drop #26008 accessor") — so this must ceiling the TOTAL refs
// in the document, not just the ones we create. encodeNotes enforces that by
// counting pre-existing `#N` text in the input and creating fewer short refs
// to compensate.
export const SHORT_REF_BUDGET = 450;

// Blocks re-matching a URL already wrapped as `[#N](url)` (it sits right after
// `](`), which is what makes both encoders below idempotent on encoded text.
const PULL_URL_RE = /(?<!\]\()https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g;
const COMPARE_URL_RE = /(?<!\]\()https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/compare\/(\S+)$/gm;

// A bare #N anywhere in the raw input (PR titles routinely mention other
// issues/PRs this way) costs GitHub's resolution budget exactly like a #N we
// create — counted here so encodeNotes can subtract it up front.
const INCIDENTAL_REF_RE = /#\d+/g;

export function encodeNotes({ body, budget = SHORT_REF_BUDGET }) {
  const incidental = body.match(INCIDENTAL_REF_RE)?.length ?? 0;
  // Floor at 0: an input with more incidental refs than budget degrades to
  // all-explicit-links rather than an unusable negative allowance.
  const effectiveBudget = Math.max(budget - incidental, 0);
  let seen = 0;
  return body.replace(PULL_URL_RE, (url, number) => {
    seen += 1;
    return seen <= effectiveBudget ? `#${number}` : `[#${number}](${url})`;
  });
}

export function encodeForAsset(body) {
  return body
    .replace(PULL_URL_RE, (url, number) => `[#${number}](${url})`)
    .replace(COMPARE_URL_RE, (url, range) => `[${range}](${url})`);
}

// Two live observations look contradictory until you notice they're different
// operations. `gh release edit` on a DRAFT accepted a 124,970-char / 125,097-
// byte body — drafts don't enforce the cap. PUBLISHING rejected a *smaller*
// 124,922-char / 125,039-byte body. A body under the character limit was
// still rejected on publish, so enforcement can't be character-based, even
// though GitHub's own error ("body is too long (maximum is 125000
// characters)") names the wrong unit. Budgeting bytes below is safe either
// way: Buffer.byteLength(s) >= s.length for every string, so a byte budget
// satisfies a byte cap exactly and a character cap conservatively.
//
// Budgeted 1,000 bytes UNDER GitHub's 125,000 on purpose: those two data points
// only BRACKET the real cap, so a body landing between them is a coin flip —
// and packing fills to whatever limit it is given (a live-reset simulation
// landed 17 bytes under). The margin costs ~8 entries out of ~1,400, and those
// are in the attached asset either way.
export const DEFAULT_LIMIT = 124000;
const CHANGED_HEADING = "## What's Changed";
const CONTRIBUTORS_HEADING = '## New Contributors';
const FULL_CHANGELOG_PREFIX = '**Full Changelog**:';
const byteLength = text => Buffer.byteLength(text, 'utf8');

// Math.max(...,0) clamps negative limits to empty (unlike slice()'s
// wrap-from-end). Math.trunc first: `cut` is used as a Buffer index below, and
// a fractional limit (e.g. --limit 58.5) makes `buffer[58.5]` read undefined
// — the continuation-byte walk silently no-ops, then Buffer.toString's own
// integer coercion on `end` still cuts mid-character. Trunc guarantees `cut`
// is always a valid integer index, so the walk actually runs.
function truncateToByteBoundary({ text, limit }) {
  const buffer = Buffer.from(text, 'utf8');
  let cut = Math.max(Math.trunc(limit), 0);
  while (cut > 0 && (buffer[cut] & 0xc0) === 0x80) cut -= 1;
  return buffer.toString('utf8', 0, cut);
}

function bannerFor({ shown, total, tag, limit }) {
  return [
    '',
    '> [!WARNING]',
    `> Showing ${shown} of ${total} entries — this body is capped at ${limit} bytes to stay under GitHub's limit.`,
    `> Complete notes attached as \`release-notes-${tag}.md\`.`,
    '',
  ].join('\n');
}

// The tail is everything from "## New Contributors" onward, or from the Full
// Changelog line when there are no new contributors. It always survives
// truncation — only the entry list above it gets cut.
function splitTail(lines) {
  const markers = [
    lines.findIndex(line => line.startsWith(CONTRIBUTORS_HEADING)),
    lines.findIndex(line => line.startsWith(FULL_CHANGELOG_PREFIX)),
  ].filter(index => index !== -1);
  const tailStart = markers.length ? Math.min(...markers) : lines.length;
  return { head: lines.slice(0, tailStart), tail: lines.slice(tailStart) };
}

/**
 * Guarantee a publishable body. Under the cap the input comes back untouched;
 * over it, entries are dropped from the bottom behind a warning banner while
 * the contributors block and compare link are kept. The caller is expected to
 * attach the complete notes as a release asset whenever `truncated` is true —
 * that asset, not this body, is what preserves the dropped content.
 */
export function fitToLimit({ body, tag, limit = DEFAULT_LIMIT }) {
  const lines = body.split('\n');
  const { head, tail } = splitTail(lines);
  const hasHeading = head[0]?.startsWith(CHANGED_HEADING) ?? false;
  const heading = hasHeading ? head[0] : CHANGED_HEADING;
  const entries = hasHeading ? head.slice(1) : head;
  const total = entries.filter(line => line.startsWith('* ')).length;

  if (byteLength(body) <= limit) return { body, truncated: false, shown: total, total };

  const assemble = ({ kept, shown, tailLines }) =>
    [heading, bannerFor({ shown, total, tag, limit }), ...kept, ...tailLines].join('\n');

  // Pathological case: the reserved tail alone blows the budget (thousands of
  // new contributors). Strip it back to the compare link so a body still ships.
  let tailLines = tail;
  if (byteLength(assemble({ kept: [], shown: total, tailLines })) > limit) {
    const changelogLine = tail.find(line => line.startsWith(FULL_CHANGELOG_PREFIX));
    tailLines = changelogLine ? ['', changelogLine] : [];
  }

  // Measure the banner at its widest (shown === total, so max digit count) —
  // the real banner can only be shorter, never pushing the body over.
  let used = byteLength(assemble({ kept: [], shown: total, tailLines }));
  const kept = [];
  for (const line of entries) {
    const cost = byteLength(line) + 1;
    if (used + cost > limit) break;
    used += cost;
    kept.push(line);
  }

  const shown = kept.filter(line => line.startsWith('* ')).length;
  const assembled = assemble({ kept, shown, tailLines });
  // Floor of last resort: the stripped tail can itself exceed a pathologically
  // small limit; truncateToByteBoundary keeps "body <= limit" (bytes) true always.
  return {
    body: byteLength(assembled) > limit ? truncateToByteBoundary({ text: assembled, limit }) : assembled,
    truncated: true,
    shown,
    total,
  };
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag.startsWith('--')) throw new Error(`release-notes: unexpected argument ${flag}`);
    parsed[flag.slice(2)] = argv[index + 1];
  }
  return parsed;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const { tag, out } = parsed;
  const rawOut = parsed['raw-out'];

  if (!tag || !out) {
    console.error(
      'usage: release-notes.mjs --tag <tag> --out <path> [--raw-out <path>] [--limit <bytes>]',
    );
    process.exit(1);
  }

  // Checked before reading stdin: a bad --limit shouldn't cost us buffering
  // a potentially large stream first. NaN and <= 0 both defeat fitToLimit's
  // own floor clamp's purpose (a cap must be a positive number to cap at).
  const limit = parsed.limit ? Number(parsed.limit) : undefined;
  if (limit !== undefined && !(Number.isFinite(limit) && limit > 0)) {
    console.error(`release-notes: --limit must be a positive number, got "${parsed.limit}"`);
    process.exit(1);
  }

  const raw = await readStdin();
  if (raw.trim() === '') {
    console.error('release-notes: empty notes on stdin');
    process.exit(1);
  }

  const result = fitToLimit({
    body: encodeNotes({ body: raw }),
    tag,
    limit,
  });

  await fs.writeFile(out, result.body, 'utf8');
  if (result.truncated && rawOut) await fs.writeFile(rawOut, encodeForAsset(raw), 'utf8');

  const verdict = result.truncated
    ? `truncated to ${result.shown}/${result.total} entries, full notes → ${rawOut}`
    : 'fits';
  // Bytes, not just chars: the live failure this script fixes was 39 bytes
  // over while the char count looked comfortably under — that's the number
  // an operator needs in the Actions log to tell accept from reject.
  console.log(
    `release-notes: ${raw.length} → ${result.body.length} chars / ${byteLength(result.body)} bytes (${verdict})`,
  );
}

// import.meta.url and process.argv[1] can each independently be a symlink or
// its resolved target — it depends on how Node was invoked (plain vs.
// --preserve-symlinks-main) and how the script was reached (e.g. macOS's
// /tmp -> /private/tmp). Resolving only one side fixes one direction and
// flips the mismatch under the other, so resolve both through realpath before
// comparing. Any failure (missing argv[1], deleted file) degrades to "not the
// entrypoint" instead of throwing at module evaluation.
function isMainEntrypoint() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainEntrypoint()) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
