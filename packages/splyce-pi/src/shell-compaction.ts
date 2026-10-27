// Compacts shell output for the model: strips ANSI, keeps the last frame of
// carriage-return progress, folds repeated lines, groups known-noisy tool lines
// and keeps head + tail under a byte budget. A line that looks like a failure
// is never dropped. Pure: the caller keeps the raw text.

export const COMPACT_BYTES = 8 * 1024;
// Output at or under this size is returned as is (after ANSI and CR cleanup).
const SHORT = 1024;
const LONG_LINE = 1200;
const MARKER_BYTES = 48;
const ANSI =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
// Kept in every case, wherever it sits in the output.
const SIGNAL =
  /error|fail|panic|exception|traceback|\bwarn(?:ing)?s?\b|✖|FAILED/i;
// Lines this module wrote to mark a cut; kept so compaction is idempotent.
// Anchored and short: ordinary output that merely starts like a marker is not one.
const MARKER =
  /^\[(?:… \d+ lines elided|\d+ [a-z-]+ lines: .*|output truncated)\]$/;
const marker = (l: string) => l.length <= 200 && MARKER.test(l);
const NOISE: readonly (readonly [string, RegExp])[] = [
  [
    "passing-test",
    /^\s*(?:✓|✔|PASS\b|PASSED\b|ok\b|test .+ \.\.\. ok\b|\.+\s*(?:\[\s*\d+%\])?$|\S+\.py\s+[.sx]+\s*(?:\[\s*\d+%\])?$)/,
  ],
  [
    "build",
    /^\s*(?:Compiling|Downloaded|Downloading|Fresh|Checking|Blocking|Updating|Locking|Adding|Packaging)\s/,
  ],
  [
    "progress",
    /^(?:npm (?:http|notice|info|timing|warn deprecated|WARN deprecated)\b|remote: |(?:Receiving|Resolving|Compressing|Counting|Enumerating|Unpacking|Writing) (?:objects|deltas))/,
  ],
];
const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s).length;
const pinned = (l: string) => SIGNAL.test(l) || marker(l);
const clip = (s: string) => {
  const t = s.trim();
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
};
const noise = (l: string) =>
  pinned(l) ? undefined : NOISE.find(([, re]) => re.test(l))?.[0];

export function compact(
  raw: string,
  budget = COMPACT_BYTES,
): { text: string; lossy: boolean } {
  const cleaned = raw
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .flatMap((l) => {
      if (!l.includes("\r")) return [l];
      // A frame that looks like a failure is kept; the last frame is the live one.
      const frames = l.split("\r").filter(Boolean);
      const last = frames.pop() ?? "";
      return [...frames.filter((f) => f !== last && SIGNAL.test(f)), last];
    });
  if (bytes(cleaned.join("\n")) <= Math.min(SHORT, budget))
    return { text: cleaned.join("\n"), lossy: false };

  let lossy = false;
  // 1. Repeated consecutive lines become one line with a count; blank runs shrink to one.
  const folded: string[] = [];
  for (let i = 0; i < cleaned.length;) {
    let j = i;
    while (j + 1 < cleaned.length && cleaned[j + 1] === cleaned[i]) j++;
    const line = cleaned[i] as string;
    if (line === "" || j === i)
      folded.push(...cleaned.slice(i, line === "" ? i + 1 : j + 1));
    else {
      folded.push(`${line} (x${String(j - i + 1)})`);
      lossy = true;
    }
    i = j + 1;
  }
  // 2. Runs of three or more noisy lines of one kind become one summary line;
  //    an over-long line that is not a signal keeps only its two ends.
  const grouped: string[] = [];
  for (let i = 0; i < folded.length;) {
    const kind = noise(folded[i] as string);
    let j = i;
    while (
      kind &&
      j + 1 < folded.length &&
      noise(folded[j + 1] as string) === kind
    )
      j++;
    if (kind && j - i >= 2) {
      grouped.push(
        `[${String(j - i + 1)} ${kind} lines: ${clip(folded[i] as string)} … ${clip(folded[j] as string)}]`,
      );
      lossy = true;
    } else
      for (const l of folded.slice(i, j + 1)) {
        if (l.length > LONG_LINE && !pinned(l)) {
          grouped.push(
            `${l.slice(0, 500)} […${String(l.length - 1000)} chars…] ${l.slice(-500)}`,
          );
          lossy = true;
        } else grouped.push(l);
      }
    i = j + 1;
  }
  // 3. Over budget: keep signal lines, then head and tail, and count what was cut.
  const sizes = grouped.map((l) => bytes(l) + 1);
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= budget) return { text: grouped.join("\n"), lossy };
  const kept = grouped.map(pinned);
  const fixed = sizes.reduce((a, s, i) => a + (kept[i] ? s : 0), 0);
  const room =
    budget - fixed - MARKER_BYTES * (kept.filter(Boolean).length + 2);
  if (room > 0) {
    let head = 0;
    for (let i = 0; i < grouped.length; i++) {
      if (kept[i]) continue;
      if (head + (sizes[i] as number) > room / 2) break;
      head += sizes[i] as number;
      kept[i] = true;
    }
    let tail = 0;
    for (let i = grouped.length - 1; i >= 0; i--) {
      if (kept[i]) continue;
      if (tail + (sizes[i] as number) > room / 2) break;
      tail += sizes[i] as number;
      kept[i] = true;
    }
  }
  const text: string[] = [];
  for (let i = 0; i < grouped.length;) {
    if (kept[i]) text.push(grouped[i++] as string);
    else {
      let j = i;
      while (j < grouped.length && !kept[j]) j++;
      text.push(`[… ${String(j - i)} lines elided]`);
      i = j;
    }
  }
  return { text: text.join("\n"), lossy: true };
}
