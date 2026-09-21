#!/usr/bin/env node
/**
 * Generate duplicate-candidate pairs before spending any model calls.
 *
 * Comparing every issue to every other is quadratic: 200 issues is ~20k pairs.
 * A cheap lexical pass throws away the obviously-unrelated ones so Jev only
 * judges pairs a human would also consider worth a second look.
 *
 *   node scripts/candidates.mjs < issues.json > pairs.json
 *   node scripts/candidates.mjs --min-overlap 0.25 --limit 100 < issues.json
 */

import { readFileSync } from "node:fs";

const STOP = new Set(
  ("the a an and or but if then when of to in on at for with from by is are was were be been " +
   "it its this that these those not no does do did can could should would will i we you " +
   "issue bug error problem when trying")
    .split(" "),
);

function tokens(issue) {
  const text = `${issue.title ?? ""} ${(issue.description ?? "").slice(0, 600)}`.toLowerCase();
  return new Set(
    text.split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) =>
    argv.includes(name) ? Number(argv[argv.indexOf(name) + 1]) : fallback;

  const minOverlap = arg("--min-overlap", 0.18);
  const limit = arg("--limit", 200);
  const sameTeamOnly = !argv.includes("--cross-team");

  const input = JSON.parse(readFileSync(0, "utf8"));
  const issues = input.issues ?? [];
  const toks = new Map(issues.map((i) => [i.id, tokens(i)]));

  const pairs = [];
  for (let i = 0; i < issues.length; i++) {
    for (let j = i + 1; j < issues.length; j++) {
      const a = issues[i];
      const b = issues[j];
      if (sameTeamOnly && a.team && b.team && a.team !== b.team) continue;
      const overlap = jaccard(toks.get(a.id), toks.get(b.id));
      if (overlap < minOverlap) continue;
      pairs.push({ overlap: Number(overlap.toFixed(3)), a, b });
    }
  }

  // Judge the most similar pairs first so a --limit cut loses the weakest ones.
  pairs.sort((x, y) => y.overlap - x.overlap);
  const kept = pairs.slice(0, limit);

  process.stderr.write(
    `candidates: ${issues.length} issues → ${(issues.length * (issues.length - 1)) / 2} possible pairs → ${pairs.length} above ${minOverlap} → ${kept.length} kept\n`,
  );
  process.stdout.write(JSON.stringify({ pairs: kept }, null, 2) + "\n");
}

main();
