# linear-triage

A Claude skill that triages, prioritizes, and sizes a Linear queue using
[TypeSafe System One](https://docs.typesafe.ai) (Jev) for the judgment calls. It
routes and labels issues, derives priority from scored severity/reach/urgency,
derives estimates from scored effort, ranks a backlog, and flags duplicates,
stale issues, and unactionable reports — then **proposes** everything for
approval. It never writes to Linear on its own.

It works over any range you can name: a triage inbox, a status, everything in a
milestone, a project's issues that have no milestone yet, a cycle, a label.

## Setup

```bash
export TYPESAFE_API_KEY=...        # from typesafe.ai
```

Authorize the Linear connector in Claude Code with `/mcp` → "claude.ai Linear".

Install the skill so Claude can find it:

```bash
ln -s "$PWD" ~/.claude/skills/linear-triage
```

## Layout

```
SKILL.md                     the workflow Claude follows
config/triage.config.json    level descriptions, weights, thresholds, bands — tune this
scripts/scope.mjs            select the range to act on (no API calls)
scripts/judge.mjs            issues → typed judgments via Jev
scripts/pr-metrics.mjs       size completed work from its merged PRs (needs gh)
scripts/candidates.mjs       cheap duplicate-candidate blocking (no API calls)
scripts/retune.mjs           re-derive priority and estimates from saved judgments (no API calls)
references/typesafe.md       API contract and primitive selection
references/linear.md         priority enum, estimate scales, connector quirks
```

Everything reads JSON on stdin and writes JSON on stdout, so the whole pipeline
runs against fixture files with no Linear access at all:

```bash
node scripts/scope.mjs --project "Native app" --no-milestone < fetched.json \
  | node scripts/judge.mjs > proposals.json
```

`--dry-run` shows exactly what would be asked of Jev without sending anything,
and needs no API key.

## Selecting a range

`scope.mjs` turns "the part of the queue I meant" into a filtered set plus an
audit trail, before a single model call is spent:

```bash
node scripts/scope.mjs --state-type backlog --team ENG          < fetched.json
node scripts/scope.mjs --project "Native app" --milestone Beta  < fetched.json
node scripts/scope.mjs --project "Native app" --no-milestone    < fetched.json
node scripts/scope.mjs --state-type triage --unprioritized      < fetched.json
node scripts/scope.mjs --milestone Beta --unestimated           < fetched.json
```

```
scope: 214 fetched → 38 matched → 38 selected
  − 148 state_type
  − 26 estimate_unset
  ! 9 of 38 issues have an empty description…
```

Some of these are not expressible as a Linear query. "In this project but not in
any milestone" is the clearest case — there is no filter for the *absence* of a
milestone — so the range is fetched wide and partitioned locally. Completed and
canceled issues are dropped unless you ask for them.

## A note on fetch fidelity

`list_issues` truncates `description` to 500 characters and returns no comments.
`get_issue` and `list_comments` return the full text, one call each. A scoped
pass therefore chooses between truncated evidence and one-call-per-issue
fidelity — `scope.mjs` warns when the selection looks thin so the choice is
explicit rather than accidental. See `references/linear.md` for the full set of
connector field shapes, which are not the ones you would guess.

## How priority is derived

Rather than asking "what priority is this?", three dimensions are scored
independently and combined in code:

```
urgency = 0.5·severity + 0.3·reach + 0.2·time_sensitivity   →  Linear priority
```

## How an estimate is derived

Same shape, same reason:

```
effort = 0.5·scope + 0.3·unknowns + 0.2·coordination   →  a position on the scale
```

- **scope** — how much of the product changes. Extent, not difficulty.
- **unknowns** — how much has to be figured out before someone could start.
- **coordination** — how much depends on people or systems outside the assignee.

Four decisions that a single "how many points?" question could not make:

- **Bands, not arithmetic.** Linear's scales are non-linear (Fibonacci 1, 2, 3,
  5, 8; exponential 1, 2, 4, 8, 16), so effort maps to a *position* on the scale
  through configured bands. The same config works for a team on 1–5 and a team on
  T-shirts.
- **Withheld rather than guessed.** If the issue isn't estimable or isn't
  actionable, the recommendation is `refine` and no number is proposed — Linear
  feeds estimates into cycle capacity and completion graphs, where a fabricated
  number is invisible as a guess and does real damage.
- **Split rather than inflated.** Top of the scale plus high unknowns yields
  `split`, following Linear's own guidance that a large estimate usually reports
  uncertainty rather than volume. This is why the default bands never reach the
  extended values.
- **Existing estimates are left alone** unless you pass `--reestimate`.

The scale itself is never assumed. The MCP connector doesn't expose
`issueEstimationType`, so `scope.mjs` infers it from estimates already on the
team's issues and refuses to commit when the values fit more than one scale —
`{1, 2, 3}` fits three of the four.

## How good are the estimates?

Measured once against a real milestone (28 issues, 22 with linked PRs), judged
estimates correlate with actual PR churn at only **0.37**, and they run
**systematically small** — every issue that measured XL by churn came back M or S.
A description states intent; intent does not carry extent.

Estimate confidence is the usable signal: at ≥ 0.80 the judged size matched
measured churn 7/10 within one size; below 0.80, 4/12.

So: size completed work from its merged PR where one exists, and judge only what
has no measurement. `pr-metrics.mjs` does the measuring, and `--merge` applies
that rule to a judged run:

```bash
node scripts/scope.mjs --milestone v9.5.3 --include-terminal < fetched.json > scoped.json
node scripts/judge.mjs --only estimate < scoped.json > judged.json
node scripts/pr-metrics.mjs --repo owner/name --merge judged.json < scoped.json > final.json
```

Each estimate then carries `source: "pr_metrics" | "judged"`, the judged value it
replaced, and — where it was judged — why no measurement was available.

It needs the `gh` CLI. Two things worth knowing before trusting a run: include
`gitBranchName` in the Linear fetch (the exact-branch match is the only
unambiguous link, and without it every issue falls back to a text search), and
note that GitHub's search API allows just **30 requests a minute**, so the script
throttles and backs off rather than reporting a rate-limited lookup as "no PRs".

See "What the estimates are worth" in SKILL.md.

## Retuning is free

Weights, thresholds, and bands are applied after the model answers, so "we're
calling too much Urgent" or "our 5s are way too big" is a policy change and a
rerun of `retune.mjs`, not a re-judgment — the evidence didn't change:

```bash
node scripts/retune.mjs --urgent 0.85               < proposals.json
node scripts/retune.mjs --bands 0.05,0.10,0.20,0.60 < proposals.json
node scripts/retune.mjs --split-unknowns 0.99       < proposals.json
```

Rewording a level description *is* a re-judgment, because it changes the question.

## Cost shape

One request per issue carries every independent question at once — work kind,
three priority dimensions, three effort dimensions, hygiene checks, and one per
candidate label. Prioritizing and sizing the same issue is one request, not two.
Use `--only priority` or `--only estimate` when the user genuinely asked for one
thing. Duplicate detection only sees pairs that survive lexical blocking, which
takes a 200-issue queue from ~20k possible comparisons to a couple hundred.
