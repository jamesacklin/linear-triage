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

## Connector notes

Discover the exact tool names at runtime rather than assuming them — the
`claude.ai Linear` connector's surface changes. Look for the list/search/update
issue tools and read their schemas before the first call.

Two practical points:

- List endpoints paginate and often omit `description` and comments. Those are
  exactly the fields the judgments depend on, so fetch issues individually, or
  with a query that includes them, before judging.
- `https://mcp.linear.app/sse` is retired and returns 404. The working endpoint
  is `https://mcp.linear.app/mcp`.

## Scope queries worth knowing

- Triage inbox: state type `triage`
- Unprioritized: `priority = 0` among non-terminal states
- Stale: not updated in N days, still open
- Unlabeled: empty label set in an active state
