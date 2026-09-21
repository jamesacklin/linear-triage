---
name: linear-triage
description: >
  Triage a team's Linear queue using TypeSafe System One (Jev) for the judgment
  calls: route and label untriaged issues, assign priority from scored severity
  and reach, rank a backlog, and flag hygiene problems like duplicates, stale
  issues, and reports nobody can act on. Every change is proposed for approval
  before anything is written back to Linear. Use this whenever the user mentions
  triaging, grooming, prioritizing, labeling, or cleaning up Linear issues, their
  triage inbox, their backlog, or their team's queue — including vaguer asks like
  "what should we work on next?", "is anything falling through the cracks?", or
  "sort out these bugs", and even when they do not name TypeSafe or Jev.
---

# Triaging a Linear queue with System One

Triage is a pile of small judgments — how bad is this, who does it belong to, have
we seen it before — wrapped in bookkeeping. The bookkeeping is code's job. The
judgments go to Jev, which returns typed answers with probabilities instead of
prose, so the decisions that follow are auditable and the thresholds are yours.

The division that makes this work:

| Concern | Owner | Why |
| --- | --- | --- |
| Fetching issues, writing changes | You, via the Linear MCP connector | Needs the user's auth and their approval |
| Shortlisting which labels to even ask about | `scripts/judge.mjs` in plain code | Free, and keeps the model's question count bounded |
| Semantic judgments | `scripts/judge.mjs` → Jev | Needs reading comprehension |
| Dates, counts, ranking, thresholds | `scripts/judge.mjs` in plain code | Deterministic; a model would only add noise and cost |

**Nothing writes to Linear without explicit approval.** This is the core
constraint, not a safety default to relax when the proposals look good. A triage
pass touches a real team's queue, and a wrong priority or a bad merge costs more
to undo than to prevent.

## Before you start

Both of these must be true, and it is kinder to check up front than to fail midway:

- `TYPESAFE_API_KEY` is set. If not, stop and ask — there is no useful fallback.
- The Linear MCP connector is authenticated. If its tools are missing, tell the
  user to run `/mcp` and authorize "claude.ai Linear".

## The loop

### 1. Establish the vocabulary

Fetch the team's labels, workflow states, projects, and members from Linear
*before* judging anything. The judgments are built from this vocabulary at
runtime rather than hardcoded, because a skill that ships a fixed list of labels
starts rotting the day someone renames one.

Label *descriptions* matter more than names here — they become the criteria Jev
judges against. If a label has no description, its name is all the model gets,
and the answers will be correspondingly vague. That is worth telling the user
when you see it: it is usually a two-minute fix in Linear that improves every
future run.

### 2. Pull the issues in scope

Match the scope to the ask:

- *"triage the inbox"* → issues in a triage/unstarted state with no priority set
- *"what should we work on?"* → open, unblocked issues on the team
- *"is anything rotting?"* → open issues not updated recently

Fetch descriptions **and comments**. Reproduction steps, "me too" signals, and the
actual requirement usually arrive in the comments, and Jev can only read what you
put in the state.

### 3. Judge

```bash
echo '{"issues":[...],"labels":[...]}' | node scripts/judge.mjs > /tmp/proposals.json
```

Each issue becomes one request carrying every independent question at once —
work kind, severity, reach, time sensitivity, actionability, and one yes/no per
*candidate* label. Batching is not a micro-optimization: the state is sent once
instead of once per question, and the questions are answered in parallel.

**Labels are shortlisted in code first.** A mature Linear team carries far more
labels than are worth judging — the team this was built against has 99, of which
83 have no description at all. One Noul per label would mean ~99 questions per
issue and ~4,000 for a single triage pass, most of them judging a bare word.
`planLabels` blocks that down to a handful the same way duplicate detection
blocks pairs: exclude bookkeeping groups such as release tags, keep labels
already applied (confirming or removing one is part of triage), then take the
lexically plausible remainder. In practice this is 8–12 questions instead of 99.

Blocking is deliberately recall-oriented. A weak candidate costs one cheap Noul
and the model rejects it; a label never asked about can never be suggested.

Some questions are speculative, which is cheaper than a second round trip:

- `has_repro` only means something for a defect, so the wording states that
  premise and code consumes it only when `work_kind` is `bug`.
- **Label-group Choices are asked, then gated.** A Choice always returns
  something, so asking "which reliability phase?" about an unrelated chore still
  yields a phase — confidently. `group_gates` in config discards the answer
  unless a gating label also scored high. The model picks the value; code
  decides whether the question applied at all. Without this, roughly half the
  issues in the trial run picked up a phase label they had no business carrying.

### 4. Find duplicate candidates before asking about them

Comparing every issue against every other is quadratic and mostly wasted. Narrow
it in code first — same team, overlapping title terms, near-in-time — then send
only the surviving pairs:

```bash
echo '{"pairs":[{"a":{...},"b":{...}}]}' | node scripts/judge.mjs --mode duplicates
```

The verdict is a three-level Score, not a yes/no, because the middle case is real
and common: two reports that share a root cause but still deserve separate
tracking. Collapsing that into "duplicate" loses information the team needs, and
merging wrongly is the expensive mistake — it destroys a report, while missing a
duplicate merely leaves one extra issue in the list.

### 5. Present proposals, grouped by how much attention they need

`review_tier` blends the priority dimensions by the same weights used to derive
priority, then takes the lower of that and the work-kind confidence.

A plain `min()` across every dimension sounds more conservative and is worse: one
structurally uncertain dimension drags every issue into the bottom tier, and a
tier that everything lands in tells the reviewer nothing. Dimensions that really
are shaky are named individually in `uncertain_dimensions`, so the reviewer
learns *what* to check rather than only that something is off.

Confidence describes how concentrated the model's probability distribution was.
It is not a probability of being correct — a confident wrong answer is an ordinary
event. Use it to decide what the user should look at closely, never as license to
skip their approval.

Lead with what changes. A table of every issue alongside an unchanged priority
buries the five decisions that actually need a human:

```markdown
## Proposed triage — 23 issues

**12 confident** · **7 worth a look** · **4 need you**

### Needs you
| Issue | Proposed | Why | Signal |
|---|---|---|---|
| ENG-412 | Urgent (was None) | Data loss, all users | severity 2.9/3, conf 0.41 |

### Hygiene
- **ENG-118 ↔ ENG-204** — likely duplicate (0.91), same root cause
- **ENG-77** — no reproduction steps; blocked on the reporter
- **ENG-31** — untouched for 90 days
```

Then ask what to apply. Accepting a whole tier at once is a reasonable thing for
the user to want; assuming it is not.

### 6. Apply only what was approved

Write back the approved subset through the Linear connector, then report what
changed and what you deliberately left. If something fails, say which issues did
not get updated — a half-applied triage pass that reports success is worse than
one that fails loudly.

## Retuning is free

Weights and thresholds in `config/triage.config.json` are applied *after* the
model answers. If the user says "this is calling too much Urgent," raise
`priority_thresholds.urgent` and recompute from the saved judgments — no new API
calls, because the evidence did not change, only the policy.

Rewording a level description in `dimensions` is different: that changes what
Jev is asked, so those issues need re-judging.

This split is the point of scoring dimensions separately instead of asking "what
priority should this be?" directly. One question returns an answer you cannot
argue with; four dimensions return evidence you can re-weigh when the team's
definition of important shifts.

## When the judgments look wrong

Work through it in this order, because the cheapest fixes are also the most common:

1. **Was the evidence there?** Check the state actually sent. A model cannot infer
   reach from a title that does not describe who is affected. Missing comments are
   the usual culprit.
2. **Do the levels describe distinguishable situations?** Each level is evaluated
   on its own, without seeing its neighbours or its number, so two levels that
   read similarly produce a split distribution and low confidence. That is the
   model reporting genuine ambiguity in the rubric, not a failure.

   This is not hypothetical. The first real run returned reach confidence of
   **0.0** on infrastructure issues, because the rubric offered "one specific
   user" and "a large share of users" with nothing in between — and the issues
   described one observed failure with an unknown true population. Adding a level
   for exactly that case ("few observed occurrences, but nothing bounds it") took
   the same issues to 0.75–0.88 without touching the model or the weights. When
   confidence is near zero, suspect the rubric has no home for the real answer.
3. **Is the policy wrong rather than the judgment?** Look at the normalized
   dimensions. If severity and reach both read correctly but the priority is
   still off, the weights are the problem.
4. **Only then reword the question.**

Jev has documented rough edges; `references/typesafe.md` covers the contract and
points at the model's jaggedness notes.

## Reference

- `references/typesafe.md` — request/response contract, primitive selection, the
  criteria-shape gotcha (Score takes an ordered array, Choice and Noul take an object)
- `references/linear.md` — priority enum (inverted: 1 is most urgent), state types,
  the connector's quirks
- `config/triage.config.json` — level descriptions, weights, thresholds
