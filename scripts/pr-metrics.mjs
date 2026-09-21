#!/usr/bin/env node
/**
 * Size completed work from the pull requests that delivered it.
 *
 * The judged estimator in judge.mjs reads a description and infers effort. That
 * works where no other evidence exists, and it has a measured bias: on the one
 * calibration run so far it correlated with actual PR churn at only 0.37 and ran
 * systematically small, because a description states *intent* and intent does
 * not carry *extent* (see "What the estimates are worth" in SKILL.md).
 *
 * Where a merged PR exists, the delivered change is not a guess. This script
 * measures it.
 *
 *   node scripts/scope.mjs --milestone v9.5.3 --include-terminal < fetched.json \
 *     | node scripts/pr-metrics.mjs --repo owner/name > measured.json
 *
 *   node scripts/pr-metrics.mjs --repo owner/name --merge proposals.json < scoped.json
 *
 * Requires the `gh` CLI, authenticated. Makes no TypeSafe calls and spends no
 * model tokens. Never writes to Linear or GitHub — it only reads.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeIssue } from "./lib/issue.mjs";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

async function gh(args, { allowFail = false } = {}) {
  try {
    const { stdout } = await execFileAsync("gh", args, { maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    if (allowFail) return "";
    if (err.code === "ENOENT") {
      throw new Error("`gh` is not installed. Install the GitHub CLI, or drop --repo and use judge.mjs alone.");
    }
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${String(err.stderr || err.message).slice(0, 300)}`);
  }
}

/**
 * Find the PRs that belong to an issue.
 *
 * Two tiers, because neither alone is enough. Linear's `gitBranchName` is the
 * branch it *suggests*, and developers often use it verbatim — an exact --head
 * match is then unambiguous. But plenty of PRs are branched by hand, so fall
 * back to a text search filtered to PRs that actually mention the issue id in
 * their branch, title, or body. A bare text search is not usable on its own:
 * searching "tlon-6533" also matches PR #6533, which is a different thing
 * entirely.
 */
async function findPRs(issue, repo) {
  const id = String(issue.identifier ?? issue.id ?? "").toLowerCase();
  if (!id) return [];
  const branch = issue.raw?.gitBranchName ?? issue.gitBranchName;

  if (branch) {
    const out = await gh(["pr", "list", "--repo", repo, "--head", branch, "--state", "all",
      "--limit", "20", "--json", "number", "-q", ".[].number"], { allowFail: true });
    const nums = out.split("\n").map((n) => Number(n)).filter(Boolean);
    if (nums.length) return nums;
  }

  // `gh search prs` exposes only number/title/body among the fields that matter
  // here — asking it for headRefName is an "Unknown JSON field" error. Search
  // broadly and decide later, once fetchPR has the branch name.
  //
  // This call is NOT allowed to fail quietly. GitHub's search API permits only
  // 30 requests a minute, far below its 5,000/hour core limit, so a pass over a
  // few dozen issues sits right on the ceiling — and a swallowed rate-limit error
  // is indistinguishable from "this issue has no PRs". That is the worst possible
  // failure for this script: it reports confident, wrong, silent emptiness.
  const out = await searchPRs(repo, id);
  try { return JSON.parse(out).map((p) => p.number); } catch { return []; }
}

/** Search with backoff, because the 30/min ceiling is easy to hit and must not be mistaken for an empty result. */
async function searchPRs(repo, id, attempt = 0) {
  try {
    return await gh(["search", "prs", "--repo", repo, id, "--limit", "30", "--json", "number"]);
  } catch (err) {
    const msg = String(err.message ?? "");
    const limited = /rate limit|secondary rate|403/i.test(msg);
    if (!limited || attempt >= 3) {
      throw new Error(`PR search failed for ${id}: ${msg.slice(0, 160)}`);
    }
    // Wait for the window to roll over rather than hammering it.
    let wait = 20_000 * (attempt + 1);
    try {
      const reset = await gh(["api", "rate_limit", "-q", ".resources.search.reset"], { allowFail: true });
      const secs = Number(reset) - Math.floor(Date.now() / 1000);
      if (Number.isFinite(secs) && secs > 0) wait = Math.min((secs + 2) * 1000, 90_000);
    } catch { /* fall back to the fixed backoff */ }
    process.stderr.write(`pr-metrics: search rate limit hit, waiting ${Math.round(wait / 1000)}s\n`);
    await new Promise((r) => setTimeout(r, wait));
    return searchPRs(repo, id, attempt + 1);
  }
}

/**
 * Does this PR actually deliver the issue, or merely mention it?
 *
 * Mentioning is not delivering. A spec routinely cites its neighbours, so
 * "the body contains TLON-1234" attributes that PR to every issue it references
 * — which then silently halves the churn of the issue it really belongs to,
 * because the shared-PR split kicks in. Found exactly that way: one PR was
 * counted against both the issue it closed and an issue its description cited.
 *
 * Accept only a link the author asserted: the id in the branch or the title, or
 * a closing keyword pointing at it.
 */
function linksTo(pr, id) {
  if (String(pr.headRefName ?? "").toLowerCase().includes(id)) return true;
  if (String(pr.title ?? "").toLowerCase().includes(id)) return true;
  const closing = new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?|part of)\\b[^\\n]{0,24}${id}`, "i");
  return closing.test(String(pr.body ?? ""));
}

/** Bot chatter is not review effort; counting it would reward noisy automation. */
function humanCount(list, bots) {
  return (list ?? []).filter((x) => {
    const login = String(x?.author?.login ?? "").toLowerCase();
    return login && !bots.some((b) => login.includes(b));
  }).length;
}

async function fetchPR(number, repo, bots) {
  const out = await gh(["pr", "view", String(number), "--repo", repo, "--json",
    "number,state,additions,deletions,changedFiles,commits,reviews,comments,createdAt,mergedAt,closedAt,headRefName,title,body"],
    { allowFail: true });
  if (!out) return null;
  let p;
  try { p = JSON.parse(out); } catch { return null; }
  return {
    number: p.number,
    state: p.state,
    headRefName: p.headRefName ?? "",
    title: p.title ?? "",
    body: p.body ?? "",
    churn: (p.additions ?? 0) + (p.deletions ?? 0),
    files: p.changedFiles ?? 0,
    commits: (p.commits ?? []).length,
    reviews: humanCount(p.reviews, bots),
    comments: humanCount(p.comments, bots),
    createdAt: p.createdAt ?? null,
    mergedAt: p.mergedAt ?? null,
    // Reported, never scored on. Wall-clock time to merge measures calendar
    // latency, not effort: on the calibration run a 4,030-line PR merged in 0.0
    // hours (self-merged) while a 13-line one took 49 (waiting for a reviewer).
    hours_to_merge: p.mergedAt ? Number(((new Date(p.mergedAt) - new Date(p.createdAt)) / 3.6e6).toFixed(1)) : null,
  };
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

/**
 * Churn to a position on the team's scale.
 *
 * Log-ish bands, because churn spans three orders of magnitude in a single
 * milestone (9 to 6,706 on the calibration run) and linear cuts would put nearly
 * everything in one bucket. The boundaries are policy — argue with them in
 * config rather than here.
 */
function bandIndex(churn, cuts) {
  for (let i = 0; i < cuts.length; i++) if (churn < cuts[i]) return i;
  return cuts.length;
}

function measure(issue, prs, cfg, shareCount) {
  const pm = cfg.pr_metrics;
  let churn = 0, files = 0, iteration = 0;
  let anyMerged = false, anyOpen = false, shared = false;

  let abandoned = 0;
  for (const p of prs) {
    // A PR that closes several issues cannot be attributed wholly to one of
    // them. Splitting evenly is a guess, so it is flagged rather than hidden.
    const share = shareCount.get(p.number) ?? 1;
    if (share > 1) shared = true;
    if (p.state === "MERGED") anyMerged = true;
    if (p.state === "OPEN") anyOpen = true;

    // Churn is the size of the change that SHIPPED. A closed-unmerged PR was an
    // attempt, not a delivery, and folding it in would say an issue was large
    // because it was got wrong four times. That rework is real effort, so it is
    // still counted — as iteration, and reported as abandoned_churn — just not
    // as delivered size. Flip count_abandoned_churn if your velocity is meant to
    // track effort spent rather than change delivered.
    const counts = pm.count_abandoned_churn || p.state === "MERGED" || p.state === "OPEN";
    if (counts) { churn += p.churn / share; files += p.files / share; }
    else abandoned += p.churn / share;

    iteration += (p.commits + p.reviews + p.comments) / share;
  }
  churn = Math.round(churn); files = Math.round(files);
  iteration = Math.round(iteration); abandoned = Math.round(abandoned);

  // A measurement is only real when the work is done and shipped. Open PRs will
  // still grow; a closed-unmerged PR is abandoned work that never landed. One
  // issue on the calibration run carried 8,118 lines of churn, 6,706 of it from
  // a PR that was closed and never merged — sizing that as delivered effort is
  // how a velocity number quietly becomes fiction.
  const measurable = issue.stateType === "completed" && prs.length > 0 && anyMerged;

  let index = null, bumped = false;
  if (prs.length) {
    index = bandIndex(churn, pm.churn_bands);
    // Heavy review iteration means the change was argued over, which is effort
    // the diff size does not show. One step up only, and never downward.
    bumped = iteration >= pm.iteration_bump_at && index < pm.churn_bands.length;
    if (bumped) index++;
  }

  return {
    pr_count: prs.length,
    prs: prs.map((p) => ({ number: p.number, state: p.state, churn: p.churn, hours_to_merge: p.hours_to_merge })),
    churn, files, iteration, abandoned_churn: abandoned,
    scale_index: index,
    measurable,
    flags: {
      no_prs: prs.length === 0,
      open_pr: anyOpen,
      no_merged_pr: prs.length > 0 && !anyMerged,
      shared_pr: shared,
      has_abandoned_work: abandoned > 0,
      iteration_bumped: bumped,
    },
    // Why this is or is not usable as a size, in the reviewer's words.
    verdict: prs.length === 0
      ? (issue.stateType === "completed" ? "no linked PR — nothing to measure" : "not started or no PR yet — nothing to measure")
      : !anyMerged ? "PRs are open or abandoned — not delivered effort"
      : issue.stateType !== "completed" ? "PRs merged but the issue is not closed — measurement is partial"
      : "measured from merged PRs",
  };
}

function resolveScale(estimation, cfg) {
  if (!estimation) return null;
  const type = estimation.type ?? estimation.scale;
  const scales = cfg.estimation?.scales ?? {};
  const key = Object.keys(scales).find((k) => !k.startsWith("_") && k.toLowerCase() === String(type).toLowerCase());
  if (!key) return null;
  const def = scales[key];
  const ext = Boolean(estimation.extended);
  return {
    type: key,
    values: ext ? [...def.values, ...(def.extended ?? [])] : [...def.values],
    labels: def.labels ? (ext ? [...def.labels, ...(def.extended_labels ?? [])] : [...def.labels]) : null,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const val = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
  const repo = val("--repo") ?? process.env.LINEAR_TRIAGE_REPO;
  if (!repo) throw new Error("--repo owner/name is required (or set LINEAR_TRIAGE_REPO).");

  const cfg = JSON.parse(readFileSync(val("--config") ?? join(HERE, "..", "config", "triage.config.json"), "utf8"));
  if (!cfg.pr_metrics) throw new Error("config is missing the pr_metrics section.");
  const bots = (cfg.pr_metrics.bot_authors ?? []).map((b) => b.toLowerCase());

  const input = JSON.parse(readFileSync(0, "utf8"));
  const issues = (input.issues ?? []).map(normalizeIssue);
  if (!issues.length) throw new Error("No issues on stdin. Pipe scope.mjs output in.");

  const scale = resolveScale(input.estimation, cfg);

  // The exact-branch match is the only unambiguous link. Without it every issue
  // falls through to a text search, which is looser and slower.
  if (!issues.some((i) => i.raw?.gitBranchName)) {
    process.stderr.write(
      "pr-metrics: no gitBranchName on any issue — falling back to text search for all of them.\n" +
      "  Re-fetch with gitBranchName in the field list for a stronger, faster match.\n");
  }

  // Resolve PR links first, then fetch each unique PR once — several issues can
  // share one PR, and paying for it per issue would be both slow and wrong.
  // Three at a time: the branch match uses the 5,000/hour core limit, but the
  // text fallback uses the 30/minute search limit, and a pool of six walks
  // straight into it. A failed lookup is recorded, never swallowed — "we could
  // not ask" and "there are no PRs" must not look the same downstream.
  const failures = [];
  const links = await mapPool(issues, 3, async (issue) => {
    try {
      return await findPRs(issue, repo);
    } catch (err) {
      failures.push({ id: issue.identifier, message: String(err.message ?? err) });
      return null;
    }
  });
  const unique = [...new Set(links.filter(Boolean).flat())];
  const fetched = await mapPool(unique, 8, (n) => fetchPR(n, repo, bots));
  const byNumber = new Map(fetched.filter(Boolean).map((p) => [p.number, p]));

  const shareCount = new Map();

  // Confirm each candidate now that the branch name and body are in hand, then
  // recompute sharing from the CONFIRMED links — a rejected candidate must not
  // dilute the churn of the issue that really owns the PR.
  const confirmed = issues.map((issue, k) => {
    const id = String(issue.identifier ?? issue.id ?? "").toLowerCase();
    return (links[k] ?? []).map((n) => byNumber.get(n)).filter((p) => p && linksTo(p, id));
  });
  shareCount.clear();
  for (const prs of confirmed) for (const p of prs) shareCount.set(p.number, (shareCount.get(p.number) ?? 0) + 1);

  const measured = issues.map((issue, k) => {
    const prs = confirmed[k];
    const m = measure(issue, prs, cfg, shareCount);
    // An issue whose lookup failed is unknown, not PR-less. Saying otherwise
    // would hand the reviewer a confident answer built on a swallowed error.
    if (links[k] === null) {
      m.measurable = false;
      m.lookup_failed = true;
      m.verdict = "PR lookup FAILED — unknown, not evidence of no PRs";
    }
    const idx = m.scale_index != null && scale ? Math.min(m.scale_index, scale.values.length - 1) : null;
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.stateType,
      current_estimate: issue.estimate,
      ...m,
      estimate: idx != null ? { value: scale.values[idx], display: scale.labels ? scale.labels[idx] : String(scale.values[idx]) } : null,
    };
  });

  let out = { repo, scale: scale ? { type: scale.type, values: scale.values } : null, measured };

  // --merge applies the rule the calibration implies: a real measurement beats a
  // judgment, and a judgment covers everything with no measurement.
  if (val("--merge")) {
    const judged = JSON.parse(readFileSync(val("--merge"), "utf8"));
    const byId = new Map(measured.map((m) => [m.identifier, m]));
    let fromPr = 0, fromJev = 0;
    for (const p of judged.proposals ?? []) {
      const m = byId.get(p.identifier);
      const usable = m?.measurable && m.estimate && p.estimate?.recommendation === "estimate";
      if (usable) {
        p.estimate.judged = { value: p.estimate.value, display: p.estimate.display };
        p.estimate.value = m.estimate.value;
        p.estimate.display = m.estimate.display;
        p.estimate.source = "pr_metrics";
        p.estimate.measurement = { churn: m.churn, files: m.files, iteration: m.iteration, prs: m.prs };
        fromPr++;
      } else if (p.estimate) {
        p.estimate.source = "judged";
        p.estimate.not_measured = m?.verdict ?? "issue absent from the measured set";
        fromJev++;
      }
    }
    judged.estimate_sources = { pr_metrics: fromPr, judged: fromJev };
    out = judged;
    process.stderr.write(`pr-metrics: merged — ${fromPr} measured, ${fromJev} judged\n`);
  }

  if (failures.length) {
    process.stderr.write(`pr-metrics: ${failures.length} PR lookups FAILED — those issues are unknown, not PR-less:\n`);
    for (const f of failures) process.stderr.write(`  ! ${f.id}: ${f.message.slice(0, 120)}\n`);
  }

  const n = measured.length, ok = measured.filter((m) => m.measurable).length;
  process.stderr.write(
    `pr-metrics: ${n} issues → ${unique.length} unique PRs → ${ok} measurable\n` +
    `  − ${measured.filter((m) => m.flags.no_prs).length} no linked PR\n` +
    `  − ${measured.filter((m) => m.flags.no_merged_pr).length} PRs open or abandoned\n` +
    (measured.filter((m) => m.flags.shared_pr).length
      ? `  ! ${measured.filter((m) => m.flags.shared_pr).length} share a PR with another issue; churn was split evenly, which is a guess\n` : ""),
  );
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`pr-metrics.mjs: ${err.message ?? err}\n`);
  process.exit(1);
});
