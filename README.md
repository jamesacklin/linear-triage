# linear-triage

A Claude skill that triages a Linear queue using [TypeSafe System One](https://docs.typesafe.ai)
(Jev) for the judgment calls. It routes and labels issues, derives priority from
scored dimensions, ranks a backlog, and flags duplicates, stale issues, and
unactionable reports — then **proposes** everything for approval. It never writes
to Linear on its own.

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
config/triage.config.json    level descriptions, weights, thresholds — tune this
scripts/judge.mjs            issues → typed judgments via Jev
scripts/candidates.mjs       cheap duplicate-candidate blocking (no API calls)
scripts/retune.mjs           re-derive priority from saved judgments (no API calls)
references/typesafe.md       API contract and primitive selection
references/linear.md         priority enum, state types, connector quirks
```

`judge.mjs` reads issues on stdin and writes proposals on stdout, so it runs
against fixture files with no Linear access at all:

```bash
echo '{"issues":[...],"labels":[...]}' | node scripts/judge.mjs
```

## How priority is derived

Rather than asking "what priority is this?", three dimensions are scored
independently and combined in code:

```
urgency = 0.5·severity + 0.3·reach + 0.2·time_sensitivity   →  Linear priority
```

The weights live in config and are applied after the model answers. That means
"we're calling too much Urgent" is a threshold change and a rerun of
`retune.mjs`, not a re-judgment — the evidence didn't change, only the policy.

## Cost shape

One request per issue carries every independent question at once (work kind,
three dimensions, two hygiene checks, one per label). Duplicate detection only
sees pairs that survive lexical blocking, which takes a 200-issue queue from
~20k possible comparisons to a couple hundred.
