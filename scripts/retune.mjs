#!/usr/bin/env node
/**
 * Recompute priorities from judgments already made — no API calls.
 *
 * The normalized dimensions are saved in proposals.json, so changing what the
 * team means by "important" is arithmetic, not inference. Use this when the
 * user says "too many Urgents" or "we care more about breadth than depth".
 *
 *   node scripts/retune.mjs --severity 0.4 --reach 0.4 --time 0.2 < proposals.json
 *   node scripts/retune.mjs --urgent 0.85 < proposals.json
 *
 * Rewording a level description in the config is NOT retuning: that changes the
 * question, so those issues have to go back through judge.mjs.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PRIORITY_NAME = ["No priority", "Urgent", "High", "Medium", "Low"];

function main() {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) =>
    argv.includes(name) ? Number(argv[argv.indexOf(name) + 1]) : fallback;

  const cfg = JSON.parse(readFileSync(join(HERE, "..", "config", "triage.config.json"), "utf8"));
  const weights = {
    severity: arg("--severity", cfg.weights.severity),
    reach: arg("--reach", cfg.weights.reach),
    time_sensitivity: arg("--time", cfg.weights.time_sensitivity),
  };
  const sum = weights.severity + weights.reach + weights.time_sensitivity;
  if (Math.abs(sum - 1) > 1e-6) {
    process.stderr.write(`retune: weights sum to ${sum}, not 1.0\n`);
    process.exit(1);
  }
  const t = {
    urgent: arg("--urgent", cfg.priority_thresholds.urgent),
    high: arg("--high", cfg.priority_thresholds.high),
    medium: arg("--medium", cfg.priority_thresholds.medium),
  };

  const input = JSON.parse(readFileSync(0, "utf8"));
  const changed = [];

  for (const p of input.proposals ?? []) {
    if (!p.proposed?.dimensions) continue;
    const d = p.proposed.dimensions;
    const urgency =
      weights.severity * d.severity.normalized +
      weights.reach * d.reach.normalized +
      weights.time_sensitivity * d.time_sensitivity.normalized;

    let priority = 4;
    if (urgency >= t.urgent) priority = 1;
    else if (urgency >= t.high) priority = 2;
    else if (urgency >= t.medium) priority = 3;

    const before = p.proposed.priority;
    p.proposed.urgency = Number(urgency.toFixed(3));
    p.proposed.priority = priority;
    p.proposed.priority_name = PRIORITY_NAME[priority];
    if (before !== priority) {
      changed.push(`${p.identifier}: ${PRIORITY_NAME[before]} → ${PRIORITY_NAME[priority]}`);
    }
  }

  input.retuned = { weights, thresholds: t, changed_count: changed.length };
  process.stderr.write(
    changed.length
      ? `retune: ${changed.length} priorities changed\n  ${changed.join("\n  ")}\n`
      : "retune: no priorities changed\n",
  );
  process.stdout.write(JSON.stringify(input, null, 2) + "\n");
}

main();
