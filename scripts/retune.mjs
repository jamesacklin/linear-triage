#!/usr/bin/env node
/**
 * Recompute priorities and estimates from judgments already made — no API calls.
 *
 * The normalized dimensions are saved in proposals.json, so changing what the
 * team means by "important" or by "a 3" is arithmetic, not inference. Use this
 * when the user says "too many Urgents", "we care more about breadth than
 * depth", or "our 5s are coming out way too big".
 *
 *   node scripts/retune.mjs --severity 0.4 --reach 0.4 --time 0.2 < proposals.json
 *   node scripts/retune.mjs --urgent 0.85 < proposals.json
 *   node scripts/retune.mjs --bands 0.10,0.25,0.45,0.70 < proposals.json
 *   node scripts/retune.mjs --unknowns 0.4 --scope 0.4 --coordination 0.2 < proposals.json
 *
 * Rewording a level description in the config is NOT retuning: that changes the
 * question, so those issues have to go back through judge.mjs.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PRIORITY_NAME = ["No priority", "Urgent", "High", "Medium", "Low"];

function bandIndex(effort, cuts) {
  for (const c of cuts) if (effort < c.below) return c.index;
  return cuts[cuts.length - 1].index;
}

function main() {
  const argv = process.argv.slice(2);
  const num = (name, fallback) =>
    argv.includes(name) ? Number(argv[argv.indexOf(name) + 1]) : fallback;

  const cfg = JSON.parse(readFileSync(join(HERE, "..", "config", "triage.config.json"), "utf8"));
  const ec = cfg.estimation;

  const weights = {
    severity: num("--severity", cfg.weights.severity),
    reach: num("--reach", cfg.weights.reach),
    time_sensitivity: num("--time", cfg.weights.time_sensitivity),
  };
  const sum = weights.severity + weights.reach + weights.time_sensitivity;
  if (Math.abs(sum - 1) > 1e-6) {
    process.stderr.write(`retune: priority weights sum to ${sum}, not 1.0\n`);
    process.exit(1);
  }
  const t = {
    urgent: num("--urgent", cfg.priority_thresholds.urgent),
    high: num("--high", cfg.priority_thresholds.high),
    medium: num("--medium", cfg.priority_thresholds.medium),
  };

  const ew = {
    scope: num("--scope", ec.weights.scope),
    unknowns: num("--unknowns", ec.weights.unknowns),
    coordination: num("--coordination", ec.weights.coordination),
  };
  const esum = ew.scope + ew.unknowns + ew.coordination;
  if (Math.abs(esum - 1) > 1e-6) {
    process.stderr.write(`retune: effort weights sum to ${esum}, not 1.0\n`);
    process.exit(1);
  }

  // Bands are given as the ascending upper bounds of each band; the final band
  // is open-ended, so an explicit sentinel above 1.0 closes it.
  let cuts = ec.bands.cuts;
  if (argv.includes("--bands")) {
    const bounds = argv[argv.indexOf("--bands") + 1].split(",").map(Number);
    if (bounds.some(Number.isNaN) || bounds.some((b, i) => i && b <= bounds[i - 1])) {
      process.stderr.write("retune: --bands takes ascending numbers, e.g. --bands 0.10,0.25,0.45,0.70\n");
      process.exit(1);
    }
    cuts = [...bounds.map((below, index) => ({ below, index })), { below: 1.01, index: bounds.length }];
  }
  const minEstimable = num("--min-estimable", ec.min_estimable);
  const minActionable = num("--min-actionable", ec.min_actionable);
  const splitUnknowns = num("--split-unknowns", ec.split.unknowns_min);
  const splitAt = num("--split-at", ec.split.at_index);
  const autoSuggest = num("--auto-suggest", cfg.confidence.auto_suggest);
  const needsAttention = num("--needs-attention", cfg.confidence.needs_attention);
  const uncertainBelow = num("--uncertain-below", cfg.confidence.uncertain_below ?? 0.35);

  const input = JSON.parse(readFileSync(0, "utf8"));
  const scaleValues = input.estimation?.values ?? null;
  const scaleLabels = (() => {
    const def = ec.scales[input.estimation?.type];
    if (!def?.labels) return null;
    return input.estimation?.extended ? [...def.labels, ...(def.extended_labels ?? [])] : [...def.labels];
  })();

  const changedPriority = [];
  const changedEstimate = [];

  for (const p of input.proposals ?? []) {
    if (p.proposed?.dimensions) {
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
        changedPriority.push(`${p.identifier}: ${PRIORITY_NAME[before]} → ${PRIORITY_NAME[priority]}`);
      }
    }

    // Skipped estimates carry no dimensions to re-derive from, which is the
    // right outcome: nothing was judged, so nothing changes.
    const e = p.estimate;
    if (!e?.dimensions || !scaleValues) continue;

    const effort =
      ew.scope * e.dimensions.scope.normalized +
      ew.unknowns * e.dimensions.unknowns.normalized +
      ew.coordination * e.dimensions.coordination.normalized;
    const index = Math.min(bandIndex(effort, cuts), scaleValues.length - 1);
    const value = scaleValues[index];
    const display = scaleLabels ? scaleLabels[index] : String(value);

    const blockers = [];
    if (typeof e.is_estimable === "number" && e.is_estimable < minEstimable) {
      blockers.push({ reason: "not_estimable", probability: e.is_estimable, threshold: minEstimable });
    }
    const actionable = p.proposed?.hygiene?.is_actionable;
    if (typeof actionable === "number" && actionable < minActionable) {
      blockers.push({ reason: "not_actionable", probability: actionable, threshold: minActionable });
    }
    const shouldSplit = index >= splitAt && e.dimensions.unknowns.normalized >= splitUnknowns;
    const recommendation = blockers.length ? "refine" : shouldSplit ? "split" : "estimate";

    const beforeLabel = e.value ?? e.recommendation;
    e.effort = Number(effort.toFixed(3));
    e.scale_index = index;
    e.recommendation = recommendation;
    e.value = recommendation === "estimate" ? value : null;
    e.display = recommendation === "estimate" ? display : null;
    e.would_have_been = recommendation === "estimate" ? null : { value, display };
    e.blockers = blockers;
    const afterLabel = e.value ?? e.recommendation;
    if (String(beforeLabel) !== String(afterLabel)) {
      changedEstimate.push(`${p.identifier}: ${beforeLabel} → ${afterLabel}`);
    }
  }

  // Tiering is policy too. The dimension confidences are saved alongside the
  // scores, so how they are combined into one number — and where the tier cuts
  // fall — is re-derivable without re-asking anything.
  const wmean = (conf, w) => {
    let s = 0, tot = 0;
    for (const [k, v] of Object.entries(conf)) if (typeof v === "number") { s += w[k] * v; tot += w[k]; }
    return tot ? s / tot : null;
  };
  const retiered = [];
  for (const p of input.proposals ?? []) {
    const pd = p.proposed?.dimensions;
    const ed = p.estimate?.dimensions;
    if (!pd && !ed) continue;

    const parts = [];
    if (pd) {
      const pc = wmean({ severity: pd.severity.confidence, reach: pd.reach.confidence, time_sensitivity: pd.time_sensitivity.confidence }, weights);
      const kc = p.proposed.work_kind_confidence;
      const combined = pc == null ? kc : kc == null ? pc : Math.min(pc, kc);
      if (typeof combined === "number") parts.push(combined);
    }
    if (ed) {
      const ecf = wmean({ scope: ed.scope.confidence, unknowns: ed.unknowns.confidence, coordination: ed.coordination.confidence }, ew);
      if (typeof ecf === "number") parts.push(ecf);
    }
    const confidence = parts.length ? Math.min(...parts) : null;

    const uncertain = Object.entries({
      ...(pd ? { severity: pd.severity.confidence, reach: pd.reach.confidence, time_sensitivity: pd.time_sensitivity.confidence } : {}),
      ...(ed ? { scope: ed.scope.confidence, unknowns: ed.unknowns.confidence, coordination: ed.coordination.confidence } : {}),
    })
      .filter(([, v]) => typeof v === "number" && v < uncertainBelow)
      .map(([k, v]) => ({ dimension: k, confidence: Number(v.toFixed(3)) }));

    const tier =
      confidence == null ? "needs_attention"
      : confidence >= autoSuggest ? "confident"
      : confidence >= needsAttention ? "review"
      : "needs_attention";

    const beforeTier = p.proposed?.review_tier;
    if (p.proposed) {
      p.proposed.confidence = confidence == null ? null : Number(confidence.toFixed(3));
      p.proposed.uncertain_dimensions = uncertain;
      p.proposed.review_tier = tier;
    }
    if (beforeTier && beforeTier !== tier) retiered.push(`${p.identifier}: ${beforeTier} → ${tier}`);
  }

  input.retuned = {
    weights,
    thresholds: t,
    confidence: { auto_suggest: autoSuggest, needs_attention: needsAttention, uncertain_below: uncertainBelow },
    retiered_count: retiered.length,
    effort_weights: ew,
    bands: cuts,
    estimate_gates: { min_estimable: minEstimable, min_actionable: minActionable, split_unknowns: splitUnknowns, split_at: splitAt },
    changed_priority_count: changedPriority.length,
    changed_estimate_count: changedEstimate.length,
  };

  const report = (label, list) =>
    list.length ? `retune: ${list.length} ${label} changed\n  ${list.join("\n  ")}\n` : `retune: no ${label} changed\n`;
  process.stderr.write(report("priorities", changedPriority));
  if (scaleValues) process.stderr.write(report("estimates", changedEstimate));
  process.stderr.write(report("review tiers", retiered));

  process.stdout.write(JSON.stringify(input, null, 2) + "\n");
}

main();
