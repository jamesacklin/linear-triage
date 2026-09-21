#!/usr/bin/env node
/**
 * Turn Linear issues into typed triage judgments via TypeSafe System One.
 *
 * Transport-agnostic by design: it reads issues as JSON on stdin and writes
 * proposals as JSON on stdout. Whoever fetched the issues (the Linear MCP
 * connector, a GraphQL script, a fixture file) is not this script's problem,
 * and nothing here writes back to Linear. That separation is what makes the
 * propose-then-confirm loop safe and the judgments testable offline.
 *
 *   echo '{"issues":[...],"labels":[...]}' | node scripts/judge.mjs > proposals.json
 *   node scripts/judge.mjs --mode duplicates < pairs.json
 *
 * Requires TYPESAFE_API_KEY.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai/v1/systemone";
const API_KEY = process.env.TYPESAFE_API_KEY;

// Linear's priority enum is inverted from intuition: 1 is the most urgent.
const LINEAR_PRIORITY = { none: 0, urgent: 1, high: 2, medium: 3, low: 4 };
const PRIORITY_NAME = ["No priority", "Urgent", "High", "Medium", "Low"];

const WORK_KINDS = {
  bug: {
    what: "Something in the product behaves differently than it is supposed to.",
    not_for: "A feature that works as designed but the reporter dislikes.",
    examples: ["crashes on save", "wrong total displayed", "button does nothing"],
  },
  feature: {
    what: "A capability that does not exist yet and is being requested.",
    not_for: "Restoring behaviour that used to work — that is a bug.",
    examples: ["add CSV export", "support SSO", "let me filter by assignee"],
  },
  improvement: {
    what: "Existing behaviour works but should be faster, clearer, or nicer.",
    not_for: "A wholly new capability, and not a defect.",
    examples: ["make search faster", "clearer empty state", "reduce clicks to publish"],
  },
  chore: {
    what: "Internal maintenance with no directly visible user-facing change.",
    examples: ["upgrade dependency", "delete dead code", "add CI cache"],
  },
  question: {
    what: "Someone asking how something works or requesting support, not reporting work to be done.",
    examples: ["how do I rotate my key?", "is this expected?"],
  },
  docs: {
    what: "Documentation is missing, wrong, or unclear.",
    examples: ["API reference omits the retry param", "setup guide is out of date"],
  },
};

const DUPLICATE_LEVELS = [
  { what: "Different problems. They may touch the same area of the product, but resolving one would leave the other exactly as broken as before." },
  { what: "Related. Overlapping symptoms or a plausibly shared root cause, but each describes something specific enough to be worth tracking on its own." },
  { what: "The same problem reported twice. Resolving one resolves the other; the second adds no new information a fixer would act on." },
];

// Common words pass a naive length filter and make every long label description
// "match" every issue. Without this, a label whose description merely contains
// "the" and "not" scores against unrelated work.
const STOP = new Set(
  ("the and for with from that this not but are was were has have had its their there when what which " +
   "one per all any some each into out off via when while after before should would could can may " +
   "issue issues bug bugs error errors problem fail fails failed failure user users work works")
    .split(" "),
);

const slug = (s) => s.replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase();

function loadConfig(path) {
  const raw = JSON.parse(readFileSync(path ?? join(HERE, "..", "config", "triage.config.json"), "utf8"));
  const w = raw.weights;
  const sum = w.severity + w.reach + w.time_sensitivity;
  if (Math.abs(sum - 1) > 1e-6) {
    throw new Error(`weights must sum to 1.0, got ${sum}. Fix config/triage.config.json.`);
  }
  return raw;
}

/** Strip the _comment keys we use for human readers before sending to the API. */
function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).filter(([k]) => !k.startsWith("_")).map(([k, v]) => [k, clean(v)]),
    );
  }
  return value;
}

async function systemOne(body, { retries = 4 } = {}) {
  if (!API_KEY) throw new Error("TYPESAFE_API_KEY is not set.");
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return await res.json();
      const text = await res.text().catch(() => "");
      // 4xx other than rate limiting means the request itself is wrong; retrying
      // just burns quota and hides the bug.
      if (res.status !== 429 && res.status < 500) {
        throw new Error(`TypeSafe ${res.status}: ${text.slice(0, 400)}`);
      }
      lastErr = new Error(`TypeSafe ${res.status}: ${text.slice(0, 200)}`);
    } catch (err) {
      lastErr = err;
      if (String(err.message).startsWith("TypeSafe 4")) throw err;
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 500 + Math.random() * 250));
    }
  }
  throw lastErr;
}

/**
 * Build the state for one issue. Jev reads only what we send, so anything the
 * judgment depends on has to be here — including comments, which is usually
 * where the reproduction steps and the "me too" signal actually live.
 */
function issueState(issue) {
  return {
    issue: {
      title: issue.title ?? "",
      description: issue.description ?? "",
      comments: (issue.comments ?? []).map((c) => c.body ?? c).slice(0, 20),
      reporter: issue.reporter ?? issue.creator ?? null,
      current_labels: issue.labels ?? [],
      team: issue.team ?? null,
      created_at: issue.createdAt ?? null,
      updated_at: issue.updatedAt ?? null,
    },
  };
}

/**
 * All questions for one issue go in a single request. They are independent, so
 * the service answers them in parallel and we pay for the state once instead of
 * once per question.
 *
 * Some questions are speculative — has_repro only means something if the issue
 * is a defect. We ask anyway and let code decide what to consume, which is
 * cheaper than a second round trip and keeps the premise explicit in the
 * wording so the model is not guessing at context it cannot see.
 */
/**
 * Decide which labels are worth asking about for a given issue.
 *
 * Asking one Noul per label does not survive contact with a real workspace: a
 * mature Linear team can carry a hundred labels, most of them undescribed, and
 * judging all of them per issue is both ruinously expensive and pointless —
 * release tags and bookkeeping labels are not semantic judgments at all.
 *
 * So we block first, exactly as we do for duplicate pairs: cheap lexical
 * shortlisting in code, then the model judges only a plausible handful.
 */
function planLabels(issue, labels, cfg) {
  const lc = cfg.labels ?? {};
  const maxCandidates = lc.max_candidates ?? 12;
  const excludeGroups = new Set(lc.exclude_groups ?? []);
  const excludeNames = new Set(lc.exclude_names ?? []);
  const alwaysConsider = new Set(lc.always_consider ?? []);
  const kindLabels = new Set(Object.values(lc.kind_label_map ?? {}));
  const applied = new Set(issue.labels ?? []);

  const usable = (labels ?? []).filter((l) => {
    if (l.isGroup) return false;
    if (excludeNames.has(l.name)) return false;
    if (l.parent && excludeGroups.has(l.parent)) return false;
    if (l.parent) return false; // grouped labels are handled as a Choice below
    // work_kind already decides these; asking twice invites contradiction.
    if (kindLabels.has(l.name)) return false;
    return true;
  });

  const text = `${issue.title ?? ""} ${issue.description ?? ""}`.toLowerCase();
  const issueTokens = new Set(text.split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t)));

  const relevance = (l) => {
    const hay = `${l.name} ${l.description ?? ""}`.toLowerCase();
    const toks = new Set(hay.split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t)));
    if (!toks.size) return 0;
    let hits = 0;
    for (const t of toks) if (issueTokens.has(t)) hits++;
    // A described label that matches is a stronger signal than a bare name that
    // happens to share a word, so give descriptions a modest edge.
    return (hits / toks.size) * (l.description && l.description.trim() ? 1.15 : 1);
  };

  const scored = usable
    .map((l) => ({ label: l, score: relevance(l), applied: applied.has(l.name), always: alwaysConsider.has(l.name) }))
    .sort((a, b) => Number(b.applied) - Number(a.applied) || Number(b.always) - Number(a.always) || b.score - a.score);

  // Already-applied and always-consider labels bypass the cap: confirming or
  // removing an existing label is part of triage, not an optional extra.
  const forced = scored.filter((s) => s.applied || s.always);
  const minRelevance = lc.min_relevance ?? 0.12;
  const rest = scored.filter((s) => !s.applied && !s.always && s.score >= minRelevance).slice(0, maxCandidates);
  const candidates = [...forced, ...rest].map((s) => s.label);

  // Groups are mutually exclusive by construction, so they are a Choice over
  // children, never independent yes/no questions.
  const groups = [];
  for (const g of (labels ?? []).filter((l) => l.isGroup && !excludeGroups.has(l.name))) {
    const children = (labels ?? []).filter((l) => l.parent === g.name);
    if (!children.length) continue;
    const inPlay = children.some((c) => applied.has(c.name)) || alwaysConsider.has(g.name);
    if (inPlay) groups.push({ group: g, children });
  }

  // A gated group is only usable if its gating label was actually asked about,
  // so pull that label in even when lexical blocking would have dropped it.
  const gates = lc.group_gates ?? {};
  for (const { group } of groups) {
    const gate = gates[group.name];
    if (!gate) continue;
    if (candidates.some((l) => l.name === gate.label)) continue;
    const gateLabel = (labels ?? []).find((l) => l.name === gate.label);
    if (gateLabel) candidates.push(gateLabel);
  }

  return { candidates, groups };
}

function buildQuestions(cfg, plan) {
  const d = clean(cfg.dimensions);
  const questions = {
    work_kind: {
      type: "choice",
      instructions: {
        question: "What kind of work is this issue asking for?",
        focus: "Judge what someone would have to do to close it, not the tone of the report.",
      },
      criteria: WORK_KINDS,
    },
    severity: { type: "score", instructions: d.severity.instructions, criteria: d.severity.criteria },
    reach: { type: "score", instructions: d.reach.instructions, criteria: d.reach.criteria },
    time_sensitivity: {
      type: "score",
      instructions: d.time_sensitivity.instructions,
      criteria: d.time_sensitivity.criteria,
    },
    has_repro: {
      type: "noul",
      instructions: {
        question: "If this describes a defect, does it contain enough detail for someone else to reproduce it without asking the reporter a question?",
        focus: "Steps, an environment, or a concrete example all count. If the issue is not a defect at all, answer false.",
      },
      criteria: {
        true: "A reader could attempt reproduction today from what is written here.",
        false: "A reader would have to go back to the reporter first, or this is not a defect report.",
      },
    },
    is_actionable: {
      type: "noul",
      instructions: {
        question: "Could someone pick this up and know what 'done' looks like?",
        focus: "Judge whether the desired end state is identifiable, not whether the work is easy or the solution is specified.",
      },
      criteria: {
        true: "The desired outcome is clear enough to start work and recognise completion.",
        false: "Too vague, too broad, or missing the point of what is actually wanted.",
      },
    },
  };

  // One Noul per *candidate* label rather than one Choice over all of them:
  // ungrouped labels are not mutually exclusive, and a Choice would force a
  // single winner where several genuinely apply.
  for (const label of plan.candidates) {
    const key = `label_${slug(label.name)}`;
    const described = label.description && label.description.trim();
    questions[key] = {
      type: "noul",
      instructions: {
        question: `Does the label "${label.name}" apply to this issue?`,
        focus: described
          ? `This team uses that label to mean: ${label.description}`
          : "This label has no description in Linear, so judge from the name alone and stay conservative.",
      },
      criteria: {
        true: described || `The issue is squarely about ${label.name}.`,
        false: `The issue is not about ${label.name}, or only mentions it in passing.`,
      },
    };
  }

  // Label groups are mutually exclusive: at most one child applies.
  for (const { group, children } of plan.groups) {
    const key = `group_${slug(group.name)}`;
    const criteria = {};
    for (const c of children) {
      criteria[c.name] = (c.description && c.description.trim()) || `The issue belongs in "${c.name}".`;
    }
    criteria.__none = "None of these apply to this issue.";
    questions[key] = {
      type: "choice",
      instructions: {
        question: `Which "${group.name}" value fits this issue?`,
        ...(group.description && group.description.trim() ? { focus: group.description } : {}),
      },
      criteria,
    };
  }

  return questions;
}

function compose(cfg, answers, plan) {
  // Scores come back as a probability-weighted mean of level indices, so the
  // top index is levels-1, not levels.
  const norm = (a, levels) => (a && typeof a.score === "number" ? a.score / (levels - 1) : 0);

  const severity = norm(answers.severity, cfg.dimensions.severity.criteria.length);
  const reach = norm(answers.reach, cfg.dimensions.reach.criteria.length);
  const timeSensitivity = norm(answers.time_sensitivity, cfg.dimensions.time_sensitivity.criteria.length);

  const urgency =
    cfg.weights.severity * severity +
    cfg.weights.reach * reach +
    cfg.weights.time_sensitivity * timeSensitivity;

  const t = cfg.priority_thresholds;
  let priority = LINEAR_PRIORITY.low;
  if (urgency >= t.urgent) priority = LINEAR_PRIORITY.urgent;
  else if (urgency >= t.high) priority = LINEAR_PRIORITY.high;
  else if (urgency >= t.medium) priority = LINEAR_PRIORITY.medium;

  const suggestedLabels = [];
  for (const label of plan.candidates) {
    const ans = answers[`label_${slug(label.name)}`];
    if (typeof ans?.noul === "number" && ans.noul >= (cfg.labels?.apply_threshold ?? 0.6)) {
      suggestedLabels.push({ name: label.name, probability: round(ans.noul) });
    }
  }
  suggestedLabels.sort((a, b) => b.probability - a.probability);

  // work_kind drives the kind labels so the two cannot contradict each other.
  const kindLabel = (cfg.labels?.kind_label_map ?? {})[answers.work_kind?.choice];
  if (kindLabel) {
    suggestedLabels.unshift({ name: kindLabel, probability: round(answers.work_kind?.confidence), from: "work_kind" });
  }

  // A Choice always returns something, so asking "which reliability phase?"
  // about an unrelated chore still yields a phase. The gate decides whether the
  // group applies at all; the model only decides which value within it.
  const gates = cfg.labels?.group_gates ?? {};
  const groupChoices = [];
  const groupsSkipped = [];
  for (const { group } of plan.groups) {
    const ans = answers[`group_${slug(group.name)}`];
    if (!ans?.choice || ans.choice === "__none") continue;
    const gate = gates[group.name];
    if (gate) {
      const gateAns = answers[`label_${slug(gate.label)}`];
      const gateProb = typeof gateAns?.noul === "number" ? gateAns.noul : 0;
      if (gateProb < (gate.min ?? 0.6)) {
        groupsSkipped.push({ group: group.name, would_have_been: ans.choice, gate: gate.label, gate_probability: round(gateProb) });
        continue;
      }
    }
    groupChoices.push({ group: group.name, value: ans.choice, confidence: round(ans.confidence) });
  }

  // Tier on the confidence that actually drove the outcome. Taking a plain
  // min() across every dimension sounds conservative but is not informative:
  // one structurally-uncertain dimension then pushes every issue into the
  // bottom tier, and a tier everything lands in tells the reviewer nothing.
  const dimConf = {
    severity: answers.severity?.confidence,
    reach: answers.reach?.confidence,
    time_sensitivity: answers.time_sensitivity?.confidence,
  };
  let weighted = 0, wsum = 0;
  for (const [k, v] of Object.entries(dimConf)) {
    if (typeof v === "number") { weighted += cfg.weights[k] * v; wsum += cfg.weights[k]; }
  }
  const priorityConf = wsum ? weighted / wsum : null;
  const kindConf = answers.work_kind?.confidence;
  const confidence =
    priorityConf == null ? kindConf ?? null
    : kindConf == null ? priorityConf
    : Math.min(priorityConf, kindConf);

  // Name the shaky dimensions rather than burying them in one number, so the
  // reviewer knows *what* to check instead of just that something is off.
  const uncertainBelow = cfg.confidence.uncertain_below ?? 0.35;
  const uncertain = Object.entries(dimConf)
    .filter(([, v]) => typeof v === "number" && v < uncertainBelow)
    .map(([k, v]) => ({ dimension: k, confidence: round(v) }));

  return {
    work_kind: answers.work_kind?.choice ?? null,
    work_kind_confidence: round(answers.work_kind?.confidence),
    priority,
    priority_name: PRIORITY_NAME[priority],
    urgency: round(urgency),
    dimensions: {
      severity: { normalized: round(severity), raw: round(answers.severity?.score), confidence: round(answers.severity?.confidence) },
      reach: { normalized: round(reach), raw: round(answers.reach?.score), confidence: round(answers.reach?.confidence) },
      time_sensitivity: { normalized: round(timeSensitivity), raw: round(answers.time_sensitivity?.score), confidence: round(answers.time_sensitivity?.confidence) },
    },
    labels: suggestedLabels,
    label_groups: groupChoices,
    label_groups_gated_out: groupsSkipped,
    hygiene: {
      has_repro: round(answers.has_repro?.noul),
      is_actionable: round(answers.is_actionable?.noul),
    },
    confidence: round(confidence),
    uncertain_dimensions: uncertain,
    review_tier:
      confidence == null ? "needs_attention"
      : confidence >= cfg.confidence.auto_suggest ? "confident"
      : confidence >= cfg.confidence.needs_attention ? "review"
      : "needs_attention",
  };
}

function round(n, places = 3) {
  return typeof n === "number" ? Number(n.toFixed(places)) : null;
}

/** Deterministic checks belong in code — dates are not a judgment call. */
function staleness(issue, cfg) {
  const updated = issue.updatedAt ? new Date(issue.updatedAt) : null;
  if (!updated || Number.isNaN(updated.getTime())) return null;
  const days = Math.floor((Date.now() - updated.getTime()) / 86400000);
  return { days_since_update: days, stale: days >= cfg.hygiene.stale_days };
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

async function triageIssues(input, cfg) {
  const { issues = [], labels = [] } = input;
  const usage = { input_tokens: 0, output_tokens: 0, requests: 0, label_questions: 0 };

  const proposals = await mapPool(issues, 6, async (issue) => {
    try {
      const plan = planLabels(issue, labels, cfg);
      const questions = clean(buildQuestions(cfg, plan));
      const res = await systemOne({ model: cfg.model, state: issueState(issue), questions });
      usage.requests++;
      usage.label_questions += plan.candidates.length + plan.groups.length;
      usage.input_tokens += res.usage?.input_tokens ?? 0;
      usage.output_tokens += res.usage?.output_tokens ?? 0;
      return {
        id: issue.id,
        identifier: issue.identifier ?? issue.id,
        title: issue.title,
        url: issue.url ?? null,
        current: { priority: issue.priority ?? null, labels: issue.labels ?? [], state: issue.state ?? null },
        proposed: compose(cfg, res.answers ?? {}, plan),
        staleness: staleness(issue, cfg),
      };
    } catch (err) {
      return { id: issue.id, identifier: issue.identifier ?? issue.id, title: issue.title, error: String(err.message ?? err) };
    }
  });

  return { model: cfg.model, usage, proposals };
}

async function judgeDuplicates(input, cfg) {
  const { pairs = [] } = input;
  const usage = { input_tokens: 0, output_tokens: 0, requests: 0 };

  const results = await mapPool(pairs, 6, async (pair) => {
    try {
      const res = await systemOne({
        model: cfg.model,
        state: {
          issue_a: { title: pair.a.title, description: pair.a.description ?? "" },
          issue_b: { title: pair.b.title, description: pair.b.description ?? "" },
        },
        questions: {
          relation: {
            type: "score",
            instructions: {
              question: "How do `issue_a` and `issue_b` relate as pieces of work?",
              focus: "Judge whether fixing one would resolve the other, not whether the wording is similar.",
            },
            criteria: DUPLICATE_LEVELS,
          },
          same_root_cause: {
            type: "noul",
            instructions: "Do these two reports most plausibly stem from the same underlying defect or gap?",
            criteria: {
              true: "One underlying change would address both.",
              false: "They would require separate changes.",
            },
          },
        },
      });
      usage.requests++;
      usage.input_tokens += res.usage?.input_tokens ?? 0;
      usage.output_tokens += res.usage?.output_tokens ?? 0;
      const rel = res.answers?.relation ?? {};
      const verdict = rel.score >= cfg.hygiene.duplicate_threshold ? "duplicate"
        : rel.score >= 0.5 ? "related" : "unrelated";
      return {
        a: pair.a.identifier ?? pair.a.id,
        b: pair.b.identifier ?? pair.b.id,
        verdict,
        relation_score: round(rel.score),
        confidence: round(rel.confidence),
        same_root_cause: round(res.answers?.same_root_cause?.noul),
      };
    } catch (err) {
      return { a: pair.a.identifier ?? pair.a.id, b: pair.b.identifier ?? pair.b.id, error: String(err.message ?? err) };
    }
  });

  return { model: cfg.model, usage, duplicates: results };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("No input on stdin. Pipe in JSON: {\"issues\":[...],\"labels\":[...]}");
  return JSON.parse(text);
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes("--mode") ? args[args.indexOf("--mode") + 1] : "triage";
  const configPath = args.includes("--config") ? args[args.indexOf("--config") + 1] : null;

  const cfg = loadConfig(configPath);
  const input = await readStdin();
  if (input.config) Object.assign(cfg, input.config);

  const result = mode === "duplicates" ? await judgeDuplicates(input, cfg) : await triageIssues(input, cfg);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`judge.mjs: ${err.message ?? err}\n`);
  process.exit(1);
});
