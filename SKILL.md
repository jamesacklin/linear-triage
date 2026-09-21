---
name: linear-triage
description: >
  Triage, prioritize, and size a Linear queue using TypeSafe System One (Jev) for
  the judgment calls: route and label untriaged issues, assign priority from
  scored severity and reach, assign estimates from scored effort, rank a backlog,
  and flag hygiene problems like duplicates, stale issues, and reports nobody can
  act on. Works over any selected range — a triage inbox, everything in a
  milestone, a project's issues with no milestone yet, a status, a cycle, a label.
  Every change is proposed for approval before anything is written back to Linear.
  Use this whenever the user mentions triaging, grooming, prioritizing, labeling,
  estimating, sizing, pointing, or cleaning up Linear issues, their triage inbox,
  their backlog, a milestone, or their team's queue — including vaguer asks like
  "what should we work on next?", "how big is this milestone?", "is anything
  falling through the cracks?", or "sort out these bugs", and even when they do
  not name TypeSafe or Jev.
---

# Triaging a Linear queue with System One

Triage is a pile of small judgments — how bad is this, how big is it, who does it
belong to, have we seen it before — wrapped in bookkeeping. The bookkeeping is
code's job. The judgments go to Jev, which returns typed answers with
probabilities instead of prose, so the decisions that follow are auditable and
the thresholds are yours.

The division that makes this work:

| Concern | Owner | Why |
| --- | --- | --- |
| Fetching issues, writing changes | You, via the Linear MCP connector | Needs the user's auth and their approval |
| Selecting which issues are in range | `scripts/scope.mjs` in plain code | Filtering is not a judgment, and a scope mistake is the costly one |
| Shortlisting which labels to even ask about | `scripts/judge.mjs` in plain code | Free, and keeps the model's question count bounded |
| Semantic judgments — kind, severity, reach, effort | `scripts/judge.mjs` → Jev | Needs reading comprehension |
| Dates, counts, ranking, thresholds, scale bands | `scripts/judge.mjs` in plain code | Deterministic; a model would only add noise and cost |

**Nothing writes to Linear without explicit approval.** This is the core
constraint, not a safety default to relax when the proposals look good. A triage
pass touches a real team's queue, and a wrong priority, a wrong estimate, or a
bad merge costs more to undo than to prevent.

## Before you start

Both of these must be true, and it is kinder to check up front than to fail midway:

- `TYPESAFE_API_KEY` is set. If not, stop and ask — there is no useful fallback.
  (`--dry-run` works without it and shows exactly what would be asked.)
- The Linear MCP connector is authenticated. If its tools are missing, tell the
  user to run `/mcp` and authorize "claude.ai Linear".

## The loop

### 1. Establish the vocabulary

Fetch the team's labels, workflow states, projects, milestones, and members from
Linear *before* judging anything. The judgments are built from this vocabulary at
runtime rather than hardcoded, because a skill that ships a fixed list of labels
starts rotting the day someone renames one.

Label *descriptions* matter more than names here — they become the criteria Jev
judges against. If a label has no description, its name is all the model gets,
and the answers will be correspondingly vague. That is worth telling the user
when you see it: it is usually a two-minute fix in Linear that improves every
future run.

**If the pass involves estimates, you also need the team's estimate scale**, and
the connector does not expose it — `get_team` returns no `issueEstimationType`.
Two honest routes, in order:

1. `scope.mjs` infers it from estimates already on the fetched issues and reports
   the result in `estimation_hint`. It only commits when the values pin one scale
   down. A team using 1, 2, 3 is consistent with Fibonacci, Linear, and T-shirt
   at once, so it says so instead of picking.
2. Otherwise ask. "Team Settings → General → Estimates" is where the user can
   read it off. Do not guess: proposing a 5 to a team whose scale stops at 4 is a
   write that will be rejected, and proposing an 8 to a team that uses 1–5 is
   worse because it will silently be accepted as something it is not.

### 2. Choose the range, and show what it selected

Match the scope to the ask, then resolve it in code:

```bash
node scripts/scope.mjs --state-type backlog --team ENG          < fetched.json > scoped.json
node scripts/scope.mjs --project "Native app" --milestone Beta  < fetched.json > scoped.json
node scripts/scope.mjs --project "Native app" --no-milestone    < fetched.json > scoped.json
node scripts/scope.mjs --state-type triage --unprioritized      < fetched.json > scoped.json
node scripts/scope.mjs --milestone Beta --unestimated           < fetched.json > scoped.json
```

Its output is judge.mjs's input, so the two pipe together.

Some of these ranges cannot be expressed as a Linear query at all. **"In this
project but not in any milestone"** is the clearest case: there is no filter for
the *absence* of a milestone, so the only honest route is to fetch the project's
issues and partition them here. Fetch the widest range the connector can express,
then narrow in code.

Scope is the most expensive thing to get wrong in this skill. A bad rubric costs
one re-judgment; a bad scope spends model calls on issues nobody asked about and
then proposes changes to them, and the reviewer has to notice that before
approving. So `scope.mjs` reports what it dropped and why:

```
scope: 214 fetched → 38 matched → 38 selected
  − 148 state_type
  − 26 estimate_unset
  ! 9 of 38 issues have an empty description. Jev reads only what is sent, so
    these will be judged from a title alone and should land in the low tier.
```

Read that tally back to the user before spending anything on a large range. "38
of 214" is a claim they can check; "I triaged the backlog" is not.

Two defaults worth knowing, because both are silent otherwise:

- **Completed and canceled issues are excluded** unless `--include-terminal`.
  Re-prioritizing shipped work is never what was meant.
- **Issues that already have an estimate are left alone.** A number in that field
  usually came from a person who knew more than the issue text does. Pass
  `--reestimate` to propose replacements, and expect to justify it.

### 3. Pull the issues in scope

Fetch descriptions **and comments**. Reproduction steps, "me too" signals, and the
actual requirement usually arrive in the comments, and Jev can only read what you
put in the state. This matters more for effort than for priority: a comment
saying "we tried this and it turned out the index is wrong" moves an estimate by
more than anything in the original report.

### 4. Judge

```bash
node scripts/judge.mjs < scoped.json > proposals.json          # priority, labels, estimates
node scripts/judge.mjs --only estimate < scoped.json           # sizing pass alone
node scripts/judge.mjs --only priority < scoped.json           # triage pass alone
node scripts/judge.mjs --dry-run < scoped.json                 # show the questions, send nothing
```

Each issue becomes **one request** carrying every independent question at once —
work kind, severity, reach, time sensitivity, effort scope, unknowns,
coordination, actionability, and one yes/no per *candidate* label. Batching is
not a micro-optimization: the state is sent once instead of once per question,
and the questions are answered in parallel. Prioritizing and sizing the same
issue is therefore one request, not two, which is the main reason to do them
together rather than in separate passes.

Use `--only` when the user genuinely asked for one thing. "Estimate everything in
this milestone" should not pay for twelve label questions per issue.

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

### 5. How an estimate is derived

Same shape as priority, for the same reason: asking "how many points is this?"
returns a number you cannot argue with, while three scored dimensions return
evidence you can re-band when the team's velocity turns out to be different.

```
effort = 0.5·scope + 0.3·unknowns + 0.2·coordination   →  a position on the scale
```

- **scope** — how much of the product has to change. Extent, not difficulty.
- **unknowns** — how much has to be figured out before someone could start.
- **coordination** — how much depends on people or systems outside the assignee.

Splitting them apart is what makes the result arguable. "This is an 8" invites a
shrug; "this is an 8 because almost nothing about it is known yet, even though
the change is small" invites a correction, and the correction is the point.

Four things the code does that a single question would not:

**Bands, not arithmetic.** Linear's scales are non-linear — Fibonacci runs
1, 2, 3, 5, 8 and exponential runs 1, 2, 4, 8, 16 — so an 8 is not "twice the
effort" of a 4 in score space. Mapping effort to a value is a lookup into bands
defined in config, and the bands are indexed by *position* on the scale rather
than by value, so the same config works for a team on 1–5 and a team on T-shirts.

**Withhold rather than guess.** If `is_estimable` or `is_actionable` comes back
low, the recommendation is `refine` and no number is proposed. The number that
would have been assigned is still reported as `would_have_been`, so the reviewer
can see the judgment without it being presented as an answer. This matters more
than it looks: Linear feeds estimates into cycle capacity and project completion
graphs, where a fabricated number is invisible as a guess and does real damage
downstream. An empty field is honest; a made-up 3 is not.

**Split rather than inflate.** Linear's own guidance is that a top-of-scale
estimate usually reports uncertainty rather than volume, and that the right
response is to break the issue up. So when the work lands in the top band *and*
the unknowns score is high, the recommendation is `split`, not `8`. This is also
why the default bands stop at index 4 and never reach the extended values
(Fibonacci 13 and 21, exponential 32 and 64): work that large should become
several issues, and proposing the big number instead papers over that.

**Never propose 0.** An explicit zero asserts the work costs nothing, which is a
person's call and not something to infer from a description. Teams that allow
zero estimates can still set one by hand.

### 6. Find duplicate candidates before asking about them

Comparing every issue against every other is quadratic and mostly wasted. Narrow
it in code first — same team, overlapping title terms, near-in-time — then send
only the surviving pairs:

```bash
node scripts/candidates.mjs < scoped.json | node scripts/judge.mjs --mode duplicates
```

The verdict is a three-level Score, not a yes/no, because the middle case is real
and common: two reports that share a root cause but still deserve separate
tracking. Collapsing that into "duplicate" loses information the team needs, and
merging wrongly is the expensive mistake — it destroys a report, while missing a
duplicate merely leaves one extra issue in the list.

### 7. Present proposals, grouped by how much attention they need

`review_tier` blends the priority dimensions by the same weights used to derive
priority, then takes the lower of that, the work-kind confidence, and — when the
pass sized anything — the estimate confidence. An issue is only "confident" if
everything the pass decided about it was.

**Only scored dimensions feed confidence.** The Noul gates — `is_estimable`,
`is_actionable` — decide whether to publish a number; they must not also depress
the tier. Folding one in double-counts it, and double-counts something
structural: "is there enough here to size this?" is an inherently fuzzy question,
so the answer sits near 0.5 on a large share of perfectly ordinary issues. The
first real run did exactly this and put 30 of 32 issues in the bottom tier with
none confident — the same failure a plain `min()` causes, arriving by a different
route. Gates gate; scores score.

A plain `min()` across every dimension sounds more conservative and is worse: one
structurally uncertain dimension drags every issue into the bottom tier, and a
tier that everything lands in tells the reviewer nothing. Dimensions that really
are shaky are named individually in `uncertain_dimensions`, so the reviewer
learns *what* to check rather than only that something is off.

Confidence describes how concentrated the model's probability distribution was.
It is not a probability of being correct — a confident wrong answer is an ordinary
event. Use it to decide what the user should look at closely, never as license to
skip their approval.

Lead with what changes, and say what the range was. A table of every issue
alongside an unchanged priority buries the five decisions that actually need a
human:

```markdown
## Backlog, in "Native app" with no milestone — 38 of 214 issues

**21 confident** · **12 worth a look** · **5 need you** · Fibonacci scale

### Needs you
| Issue | Priority | Estimate | Why | Signal |
|---|---|---|---|---|
| ENG-412 | Urgent (was None) | 5 | Data loss, all users | severity 2.9/3, conf 0.41 |
| ENG-355 | High (unchanged) | **split** | Top of scale, mostly unknowns | unknowns 2.8/3 |
| ENG-91  | Low (was None) | **refine** | Nobody can tell what done means | estimable 0.15 |

### Hygiene
- **ENG-118 ↔ ENG-204** — likely duplicate (0.91), same root cause
- **ENG-77** — no reproduction steps; blocked on the reporter
- **ENG-31** — untouched for 90 days

### Left alone
- 26 issues already had an estimate. Re-run with `--reestimate` to revisit them.
```

Then ask what to apply. Accepting a whole tier at once is a reasonable thing for
the user to want; assuming it is not.

**A label group is a swap, not an addition.** When a proposed group value
displaces one already on the issue, the proposal carries `replaces`. Present it
as `Investigating → Active impact`, never as `+ Active impact`: the two read
very differently to a reviewer, and on a Reliability phase the difference is
whether customer impact is claimed to be confirmed. Writing it needs
`removeLabels` alongside `addLabels` — Linear rejects the write outright if you
try to add a second child of the same group, which is how this was found.

`split` and `refine` are not estimates and must not be written to the estimate
field. They are recommendations about the issue itself — surface them as such,
and leave the field empty.

### 8. Apply only what was approved

Write back the approved subset through the Linear connector, then report what
changed and what you deliberately left. If something fails, say which issues did
not get updated — a half-applied triage pass that reports success is worse than
one that fails loudly.

## Retuning is free

Weights, thresholds, and estimate bands in `config/triage.config.json` are
applied *after* the model answers. If the user says "this is calling too much
Urgent" or "our 5s are way too big," change the policy and recompute from the
saved judgments — no new API calls, because the evidence did not change:

```bash
node scripts/retune.mjs --urgent 0.85                  < proposals.json > retuned.json
node scripts/retune.mjs --bands 0.05,0.10,0.20,0.60    < proposals.json > retuned.json
node scripts/retune.mjs --unknowns 0.5 --scope 0.3 --coordination 0.2 < proposals.json
node scripts/retune.mjs --split-unknowns 0.99          < proposals.json   # stop splitting
```

It prints exactly which issues moved, which is the thing to read back.

Rewording a level description in `dimensions` or `effort` is different: that
changes what Jev is asked, so those issues need re-judging.

This split is the point of scoring dimensions separately instead of asking "what
priority should this be?" or "how many points?" directly. One question returns an
answer you cannot argue with; several dimensions return evidence you can re-weigh
when the team's definition of important — or of a 3 — shifts.

## When the judgments look wrong

Work through it in this order, because the cheapest fixes are also the most common:

1. **Was the evidence there?** Check the state actually sent. A model cannot infer
   reach from a title that does not describe who is affected, or effort from a
   one-line report. Missing comments are the usual culprit. `--dry-run` shows
   exactly what was asked.
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

   The effort dimensions are written to keep this apart from sizing: `scope` asks
   how much changes and `unknowns` asks how much is unclear, so a one-line fix
   nobody can locate scores low and high rather than splitting one muddled
   question down the middle.
3. **Is the policy wrong rather than the judgment?** Look at the normalized
   dimensions. If severity and reach both read correctly but the priority is
   still off, the weights are the problem. If scope and unknowns read correctly
   but every estimate feels one size too big, the bands are.
4. **Only then reword the question.**

Jev has documented rough edges; `references/typesafe.md` covers the contract and
points at the model's jaggedness notes.

## Reference

- `references/typesafe.md` — request/response contract, primitive selection, the
  criteria-shape gotcha (Score takes an ordered array, Choice and Noul take an object)
- `references/linear.md` — priority enum (inverted: 1 is most urgent), estimate
  scales and where to find a team's, state types, the connector's quirks
- `config/triage.config.json` — level descriptions, weights, thresholds, bands
