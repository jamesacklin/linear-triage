#!/usr/bin/env node
/**
 * Select the range of issues a pass will act on — deterministically, in code.
 *
 * Scope is the most expensive thing to get wrong in this skill. A bad rubric
 * costs one re-judgment; a bad scope proposes changes to issues nobody asked
 * about, and the reviewer has to notice that before approving. So the selection
 * is arithmetic over fetched issues rather than a judgment, and it reports what
 * it dropped and why instead of just handing back a shorter list.
 *
 * It also exists because the Linear connector cannot express some of the ranges
 * people actually ask for. "In this project but not in any milestone" is the
 * clearest case: there is no filter for the absence of a milestone, so the only
 * honest route is to fetch the project's issues and partition them here.
 *
 *   node scripts/scope.mjs --state-type backlog < fetched.json > scoped.json
 *   node scripts/scope.mjs --project "Native app" --no-milestone < fetched.json
 *   node scripts/scope.mjs --milestone Beta --unestimated < fetched.json | node scripts/judge.mjs
 *
 * Output is shaped as judge.mjs's input, so the two pipe together directly.
 * Makes no API calls and needs no credentials.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeIssue, daysSince, TERMINAL } from "./lib/issue.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// Field shapes and the terminal-state set live in one place, because reading
// them wrong fails silently. See scripts/lib/issue.mjs.
const norm = (s) => String(s ?? "").trim().toLowerCase();
const days = daysSince;

/**
 * Each predicate is named, so an issue that drops out can be attributed to the
 * clause that dropped it. "Fetched 214, selected 31" is not a reviewable claim
 * on its own; "148 wrong state, 35 already estimated" is.
 */
function buildPredicates(scope) {
  const preds = [];
  const add = (name, fn) => preds.push({ name, fn });

  if (!scope.include_terminal) {
    add("terminal_state", (i) => !TERMINAL.has(i.stateType));
  }
  if (scope.state_type?.length) {
    const want = new Set(scope.state_type.map(norm));
    add("state_type", (i) => want.has(i.stateType));
  }
  if (scope.state_name?.length) {
    const want = new Set(scope.state_name.map(norm));
    add("state_name", (i) => want.has(norm(i.stateName)));
  }
  if (scope.team) {
    add("team", (i) => norm(i.team) === norm(scope.team));
  }
  if (scope.project) {
    add("project", (i) => norm(i.project) === norm(scope.project) || i.projectId === scope.project);
  }
  // Tri-state on purpose. `has_milestone: false` is "in no milestone", which is
  // a real and commonly wanted range; leaving it undefined means "don't care".
  if (scope.has_milestone === true) add("has_milestone", (i) => Boolean(i.milestone));
  if (scope.has_milestone === false) add("no_milestone", (i) => !i.milestone);
  if (scope.milestone) {
    add("milestone", (i) => norm(i.milestone) === norm(scope.milestone) || i.milestoneId === scope.milestone);
  }
  if (scope.cycle != null) {
    add("cycle", (i) => norm(i.cycle) === norm(scope.cycle));
  }
  if (scope.has_project === true) add("has_project", (i) => Boolean(i.project));
  if (scope.has_project === false) add("no_project", (i) => !i.project);

  if (scope.labels_any?.length) {
    const want = scope.labels_any.map(norm);
    add("labels_any", (i) => i.labels.some((l) => want.includes(norm(l))));
  }
  if (scope.labels_all?.length) {
    const want = scope.labels_all.map(norm);
    add("labels_all", (i) => want.every((w) => i.labels.some((l) => norm(l) === w)));
  }
  if (scope.labels_none?.length) {
    const want = scope.labels_none.map(norm);
    add("labels_none", (i) => !i.labels.some((l) => want.includes(norm(l))));
  }
  if (scope.unlabeled) add("unlabeled", (i) => i.labels.length === 0);

  if (scope.assignee === "unassigned") add("unassigned", (i) => !i.assignee);
  else if (scope.assignee === "assigned") add("assigned", (i) => Boolean(i.assignee));
  else if (scope.assignee) add("assignee", (i) => norm(i.assignee) === norm(scope.assignee));

  // Linear stores "no priority" as 0, not null, so an unset check has to test
  // both. Treating 0 as a real priority is how unprioritized issues end up
  // sorted above Urgent (see references/linear.md).
  if (scope.priority === "unset") add("priority_unset", (i) => !i.priority);
  else if (scope.priority === "set") add("priority_set", (i) => Boolean(i.priority));
  else if (Array.isArray(scope.priority)) {
    const want = new Set(scope.priority);
    add("priority_in", (i) => want.has(i.priority ?? 0));
  }

  if (scope.estimate === "unset") add("estimate_unset", (i) => i.estimate == null);
  else if (scope.estimate === "set") add("estimate_set", (i) => i.estimate != null);

  if (scope.updated_before_days != null) {
    add("recently_updated", (i) => (days(i.updatedAt) ?? Infinity) >= scope.updated_before_days);
  }
  if (scope.created_after_days != null) {
    add("created_too_long_ago", (i) => (days(i.createdAt) ?? Infinity) <= scope.created_after_days);
  }
  return preds;
}

/**
 * Work out which estimate scale a team uses from the values already on their
 * issues. The connector does not expose `issueEstimationType`, and asking the
 * user to go read Team Settings for something their own data already reveals is
 * a poor trade — but only when the data actually pins it down. 1, 2, 3 is
 * consistent with three of the four scales, and guessing there would silently
 * put 5s on a team whose scale stops at 4.
 */
function inferScale(issues, cfg) {
  const scales = cfg.estimation.scales;
  const seen = [...new Set(issues.map((i) => i.estimate).filter((e) => typeof e === "number" && e > 0))].sort((a, b) => a - b);

  // Better signal than the numbers, when it is there: the connector resolves the
  // estimate's display name alongside its value, and letters settle what values
  // cannot. {1, 3, 5, 8} is ambiguous between Fibonacci and T-shirt; an "M" is
  // not. This is the only way to tell those two apart, since T-shirt sizes are
  // stored as the Fibonacci numbers.
  const TSHIRT = /^(XS|S|M|L|XL|XXL|XXXL)$/i;
  const letters = [...new Set(issues.map((i) => i.estimateDisplay).filter((d) => d && TSHIRT.test(d)))];
  if (letters.length) {
    const def = scales.tShirt;
    const extended = letters.some((l) => (def.extended_labels ?? []).some((e) => e.toLowerCase() === l.toLowerCase()));
    return {
      determined: true,
      type: "tShirt",
      extended,
      observed_values: seen,
      observed_labels: letters,
      note: "Settled by the display names Linear returned, not by the numbers — T-shirt sizes are stored as the Fibonacci values, so letters are the only thing that distinguishes them.",
      candidates: ["tShirt"],
    };
  }

  if (!seen.length) {
    return {
      determined: false,
      reason: "No issue in the fetched set carries an estimate, so the scale cannot be inferred. Ask which scale the team uses (Team Settings → General → Estimates), or whether estimates are enabled at all.",
      observed_values: [],
      candidates: [],
    };
  }

  const candidates = [];
  for (const [name, def] of Object.entries(scales)) {
    if (name.startsWith("_")) continue;
    const base = new Set(def.values);
    const all = new Set([...def.values, ...(def.extended ?? [])]);
    if (!seen.every((v) => all.has(v))) continue;
    candidates.push({ scale: name, extended: seen.some((v) => !base.has(v)) });
  }

  // tShirt and fibonacci share their numbers by construction — the letters are
  // only a display layer — so they can never be told apart from values alone.
  const distinct = new Set(candidates.map((c) => (c.scale === "tShirt" ? "fibonacci" : c.scale)));

  if (!candidates.length) {
    return {
      determined: false,
      reason: `Observed estimates ${seen.join(", ")} do not fit any Linear scale. The field may be used for something else, or the fetch mixed teams with different scales.`,
      observed_values: seen,
      candidates: [],
    };
  }
  if (distinct.size === 1 && candidates.length <= 2) {
    const chosen = candidates[0];
    return {
      determined: true,
      type: chosen.scale,
      extended: chosen.extended,
      observed_values: seen,
      note: candidates.length > 1
        ? "Fibonacci and T-shirt are indistinguishable from values alone; they differ only in how Linear displays them. Confirm with the user if the proposals will be read as letters."
        : undefined,
      candidates: candidates.map((c) => c.scale),
    };
  }
  return {
    determined: false,
    reason: `Observed estimates ${seen.join(", ")} fit more than one scale (${[...distinct].join(", ")}). Ask which one the team uses rather than guessing — proposing a 5 to a team whose scale stops at 4 is a write that will be rejected.`,
    observed_values: seen,
    candidates: candidates.map((c) => c.scale),
  };
}

/** Things that will quietly weaken the judgments if nobody mentions them. */
function warnings(selected, scope) {
  const out = [];
  const n = selected.length;
  if (!n) return ["Nothing matched this scope. Widen it or check that the fetch actually covered the range."];

  const truncated = selected.filter((i) => i.descriptionTruncated).length;
  if (truncated) {
    out.push(
      `${truncated} of ${n} descriptions were cut off at 500 characters by list_issues. A judgment drawn from the first 500 characters of a 15,000-character spec is thin evidence, not a thin issue — re-fetch those with get_issue, or expect the confidence tiers to carry the doubt.`,
    );
  }
  const noDesc = selected.filter((i) => !i.description.trim()).length;
  if (noDesc) {
    out.push(`${noDesc} of ${n} issues have an empty description. Jev reads only what is sent, so these will be judged from a title alone and should land in the low-confidence tier.`);
  }
  const noComments = selected.filter((i) => !i.comments.length).length;
  if (noComments === n && n > 3) {
    out.push("No issue in this set carries comments. If the fetch dropped them, re-fetch with comments: reproduction steps and 'me too' signals usually live there.");
  }
  const teams = new Set(selected.map((i) => i.team).filter(Boolean));
  if (teams.size > 1) {
    out.push(`This range spans ${teams.size} teams (${[...teams].join(", ")}). Labels, workflow states, and estimate scales are per-team, so judge one team at a time unless you have checked they match.`);
  }
  const estimated = selected.filter((i) => i.estimate != null).length;
  if (estimated && scope.estimate !== "unset") {
    out.push(`${estimated} of ${n} issues already have an estimate. By default judge.mjs leaves those alone — pass --reestimate to propose replacements, and expect to defend overwriting a number a person put there.`);
  }
  const prioritized = selected.filter((i) => i.priority).length;
  if (prioritized && scope.priority !== "unset") {
    out.push(`${prioritized} of ${n} issues already have a priority. Proposals will show these as changes; read that column before approving a whole tier.`);
  }
  return out;
}

function parseArgs(argv) {
  const scope = {};
  const flag = (n) => argv.includes(n);
  const val = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const list = (n) => (val(n) ? val(n).split(",").map((s) => s.trim()).filter(Boolean) : undefined);

  if (val("--state-type")) scope.state_type = list("--state-type");
  if (val("--state-name")) scope.state_name = list("--state-name");
  if (val("--team")) scope.team = val("--team");
  if (val("--project")) scope.project = val("--project");
  if (val("--milestone")) scope.milestone = val("--milestone");
  if (flag("--no-milestone")) scope.has_milestone = false;
  if (flag("--has-milestone")) scope.has_milestone = true;
  if (flag("--no-project")) scope.has_project = false;
  if (val("--cycle")) scope.cycle = val("--cycle");
  if (val("--label")) scope.labels_any = list("--label");
  if (val("--label-all")) scope.labels_all = list("--label-all");
  if (val("--without-label")) scope.labels_none = list("--without-label");
  if (flag("--unlabeled")) scope.unlabeled = true;
  if (val("--assignee")) scope.assignee = val("--assignee");
  if (flag("--unassigned")) scope.assignee = "unassigned";
  if (flag("--unprioritized")) scope.priority = "unset";
  if (flag("--prioritized")) scope.priority = "set";
  if (flag("--unestimated")) scope.estimate = "unset";
  if (flag("--estimated")) scope.estimate = "set";
  if (val("--stale-days")) scope.updated_before_days = Number(val("--stale-days"));
  if (val("--created-within-days")) scope.created_after_days = Number(val("--created-within-days"));
  if (flag("--include-terminal")) scope.include_terminal = true;
  if (val("--limit")) scope.limit = Number(val("--limit"));
  return scope;
}

function main() {
  const argv = process.argv.slice(2);
  const cfgPath = argv.includes("--config") ? argv[argv.indexOf("--config") + 1] : join(HERE, "..", "config", "triage.config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));

  const input = JSON.parse(readFileSync(0, "utf8"));
  const scope = { ...(input.scope ?? {}), ...parseArgs(argv) };
  const all = (input.issues ?? []).map(normalizeIssue);

  const preds = buildPredicates(scope);
  const excluded = Object.fromEntries(preds.map((p) => [p.name, 0]));
  const selected = [];
  for (const issue of all) {
    const failed = preds.find((p) => !p.fn(issue));
    if (failed) excluded[failed.name]++;
    else selected.push(issue);
  }

  // Order before truncating, so a --limit cut keeps the oldest-untouched work
  // rather than whatever the connector happened to return first.
  selected.sort((a, b) => (days(b.updatedAt) ?? 0) - (days(a.updatedAt) ?? 0));
  const capped = scope.limit ? selected.slice(0, scope.limit) : selected;

  const estimation = input.estimation ?? undefined;
  const hint = inferScale(all, cfg);

  const out = {
    issues: capped.map((i) => i.raw),
    labels: input.labels ?? [],
    ...(estimation ? { estimation } : {}),
    estimation_hint: hint,
    selection: {
      scope,
      fetched: all.length,
      matched: selected.length,
      selected: capped.length,
      truncated: selected.length - capped.length,
      // Attributed to the first failing clause, so counts sum to the drop but
      // do not claim an issue failed only one test.
      excluded_by_first_failing_clause: Object.fromEntries(Object.entries(excluded).filter(([, v]) => v > 0)),
      state_types: tally(capped, (i) => i.stateType || "unknown"),
      projects: tally(capped, (i) => i.project ?? "(no project)"),
      milestones: tally(capped, (i) => i.milestone ?? "(no milestone)"),
      warnings: warnings(capped, scope),
    },
  };

  const s = out.selection;
  process.stderr.write(
    `scope: ${s.fetched} fetched → ${s.matched} matched → ${s.selected} selected` +
      (s.truncated ? ` (${s.truncated} dropped by --limit)` : "") +
      "\n" +
      Object.entries(s.excluded_by_first_failing_clause).map(([k, v]) => `  − ${v} ${k}`).join("\n") +
      (Object.keys(s.excluded_by_first_failing_clause).length ? "\n" : "") +
      s.warnings.map((w) => `  ! ${w}`).join("\n") +
      (s.warnings.length ? "\n" : ""),
  );
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

function tally(items, keyFn) {
  const out = {};
  for (const i of items) out[keyFn(i)] = (out[keyFn(i)] ?? 0) + 1;
  return out;
}

main();
