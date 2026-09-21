# Linear specifics

## Priority is numbered backwards

The most common bug in anything that writes Linear priorities:

| Value | Meaning |
| --- | --- |
| 0 | No priority |
| 1 | **Urgent** |
| 2 | High |
| 3 | Medium |
| 4 | Low |

Higher number means *less* urgent. Sorting by priority ascending puts "No
priority" first, ahead of Urgent — filter out 0 before ranking, or unprioritized
issues will float to the top of every list.

Note also that "no priority" is stored as `0`, not `null`. A truthiness check is
the right test for "unset"; `=== null` silently misses every one of them.

## Estimates

Estimates are opt-in per team, and each team picks a scale. From Linear's docs:

| Scale | Values | Extended adds |
| --- | --- | --- |
| Exponential | 1, 2, 4, 8, 16 | 32, 64 |
| Fibonacci | 1, 2, 3, 5, 8 | 13, 21 |
| Linear | 1, 2, 3, 4, 5 | 6, 7 |
| T-shirt | XS, S, M, L, XL | XXL, XXXL |

Four things that follow from this table and are easy to get wrong:

- **The scales are non-linear.** On Fibonacci, 8 is not twice 4 — there is no 4.
  Mapping a continuous effort score to a value has to be a band lookup, never a
  multiply-and-round, and the bands belong to positions on the scale rather than
  to the values, so the same config survives a team switching scales.
- **T-shirt sizes are Fibonacci numbers wearing letters.** They are stored as
  1, 2, 3, 5, 8, 13, 21 and only *displayed* as XS…XXXL. This means T-shirt and
  Fibonacci are indistinguishable from stored values alone, and it means a
  T-shirt team's `estimate` field takes a number, not a string.
- **Zero is a separate setting, not a scale position.** "Allow zero estimates"
  enables an explicit 0, which is different from leaving an issue unestimated.
  Unestimated issues count as 1 point in Linear's own statistics by default.
- **Estimates feed cycle capacity and project graphs.** A wrong estimate is not
  cosmetic: it changes velocity math and completion percentages downstream, where
  nobody can see it was a guess. Leaving the field empty is the honest failure.

Linear's own guidance, worth repeating because it shapes what this skill
proposes: a large estimate usually signals uncertainty about complexity rather
than known volume, and the better response is to break the issue up.

### Finding a team's scale

The GraphQL API exposes `team.issueEstimationType` (`notUsed`, `exponential`,
`fibonacci`, `linear`, `tShirt`), plus `issueEstimationAllowZero` and
`issueEstimationExtended`. **The MCP connector's `get_team` does not return any of
them** — it comes back with roughly `{id, icon, name, visibility, createdAt,
updatedAt}` and nothing about estimation.

So the scale has to come from somewhere else:

1. Infer it from estimates already on the team's issues. `scripts/scope.mjs` does
   this and reports `estimation_hint`. It refuses to commit when the observed
   values fit more than one scale, which is common — `{1, 2, 3}` fits three of
   the four.

   The strongest signal is not the numbers: the connector resolves the estimate's
   **display name** alongside its value (`{value: 3, name: "M"}`), and letters
   settle what values cannot. `{1, 2, 3, 5, 8}` is ambiguous between Fibonacci
   and T-shirt — those scales share their numbers by construction — but a single
   `"M"` decides it outright.
2. Ask the user. It is in Team Settings → General → Estimates.

Do not default to Fibonacci because it is the most popular. Proposing a 5 to a
team on the Linear scale is a rejected write; proposing an 8 to a team whose
scale stops at 5 is worse, because nothing rejects it.

## Workflow states

Each state has a `type` from a fixed set, and the human-facing `name` is
per-team. Key off `type`, never the name, or the skill breaks on any team that
renamed "Todo" to "Ready".

- `triage` — the inbox; the usual target for a routing pass
- `backlog`, `unstarted` — accepted, not begun
- `started` — in progress
- `completed`, `canceled` — terminal

## Labels

Labels can be grouped, and group members are mutually exclusive while ungrouped
labels are not. When the team uses a label group for something like issue kind,
that group is a Choice; ungrouped labels are independent Nouls.

Label `description` is optional and often empty. It is what the judgment criteria
are built from, so an empty description means the model is working from the name
alone. Flag these to the user.

## Projects and milestones

A milestone belongs to a project, so a milestone name is only unique within one.
Resolve the project first, then the milestone inside it — `--project X
--milestone Beta` rather than `--milestone Beta` alone, unless you already know
the name is unique across the workspace.

An issue's milestone lives on `projectMilestone`, and it is `null` for issues
that are in a project but not yet assigned to one of its milestones. That set —
"in the project, no milestone" — is a normal thing to want to triage and **cannot
be expressed as a connector filter**, because there is no "milestone is empty"
predicate. Fetch the project's issues and partition locally.

## Connector notes

Discover the exact tool names at runtime rather than assuming them — the
`claude.ai Linear` connector's surface changes. Look for the list/search/update
issue tools and read their schemas before the first call.

### The field shapes are not the ones you would guess

Verified against a real workspace, because guessing these wrong fails *silently*:

| Field | What `list_issues` actually returns |
| --- | --- |
| `id` | `"TLON-6526"` — the identifier. There is no separate `identifier` field |
| `status` | `"In Progress"` — the NAME, a flat string |
| `statusType` | `"started"` — the type, a flat string |
| `priority` | `{value: 3, name: "Medium"}` — an object, not a number |
| `estimate` | `{value: 3, name: "M"}` — an object; the key is **absent** when unestimated |
| `projectMilestone` | `{id, name}`, or absent |
| `team`, `project` | flat strings |
| `labels` | flat strings |

Two of these cause bugs that no error message will ever point at:

- **`priority` read as a number is never `0`**, so an "unprioritized" filter
  matches nothing and every issue looks like it already has a priority.
- **`estimate` read with `typeof x === "number"` is always false**, so every
  issue looks unestimated and the "leave existing estimates alone" guard never
  fires — you pay to re-judge work somebody already sized.

`scripts/lib/issue.mjs` normalizes both these shapes and the flatter ones that
fixtures use, in one place, for exactly this reason.

### `description` is truncated to 500 characters

`list_issues` does not omit descriptions — it **truncates them at 500 chars**,
silently and with no marker. `get_issue` returns the full text, one issue per
call. On a real run the difference was stark: a spec that is 15,000 characters in
Linear arrives as 500, losing the entire design, the task list, and the evidence.

So a scoped pass has a real choice to make, and it should be made out loud:

- Accept truncated evidence, and expect the confidence tiers to reflect it.
- Or pay one `get_issue` per issue for full fidelity.

`list_issues` returns **no comments at all**, under any `fields` selection —
`list_comments` is a separate call per issue. `scope.mjs` warns when nothing in
the selection carries comments, because that is usually a fetch that dropped them
rather than a queue with none.

### Other practical points

- **`duplicate` is a status type**, alongside `completed` and `canceled`, and it
  is terminal — the issue was closed as a copy of another. A terminal-state
  filter that only knows about completed/canceled will re-prioritize duplicates.
- Results paginate with a `cursor`; `hasNextPage` tells you to keep going. A
  365-issue project came back as 250 + 115.
- `https://mcp.linear.app/sse` is retired and returns 404. The working endpoint
  is `https://mcp.linear.app/mcp`.

## Scope queries worth knowing

| Range | How |
| --- | --- |
| Triage inbox | state type `triage` |
| Backlog | state type `backlog` |
| Unprioritized | `priority` falsy among non-terminal states |
| Unestimated | `estimate == null` (0 is a real estimate, not an absence) |
| In a milestone | project + `projectMilestone` |
| In a project, no milestone | project, `projectMilestone == null` — local filter only |
| Current cycle | `cycle` on the issue; cycles are per-team |
| Stale | not updated in N days, still open |
| Unlabeled | empty label set in an active state |
