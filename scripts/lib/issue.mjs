/**
 * One definition of what an issue looks like, shared by scope.mjs and judge.mjs.
 *
 * This exists because the Linear MCP connector's field shapes are not the ones
 * you would guess, and guessing wrong fails *quietly*: a `priority` read as an
 * object is never equal to 0, so every issue looks prioritized, and an
 * `estimate` read as an object is never `typeof "number"`, so every issue looks
 * unestimated and gets re-judged. Both were live bugs found on the first real
 * run against a real workspace.
 *
 * What the connector actually returns (verified, not assumed):
 *
 *   id               "TLON-6526"          — the identifier; there is no separate field
 *   status           "In Progress"        — a NAME, flat string
 *   statusType       "started"            — the type, flat string
 *   priority         {value: 3, name: "Medium"}
 *   estimate         {value: 3, name: "M"} — absent entirely when unestimated
 *   projectMilestone {id, name} | absent
 *   team, project    "Tlon", "S4E1"       — flat strings
 *   labels           ["Chat", "Bug"]      — flat strings
 *
 * Fixtures and hand-written JSON tend to use the flatter, more obvious shapes,
 * so both are accepted. The reshaping is done once, here, rather than at each
 * call site — which is where this class of bug hides.
 */

// `duplicate` is a real Linear status type and it is terminal: the issue was
// closed as a copy of another. Leaving it out of this set means duplicate
// issues get re-prioritized, which is worse than useless.
export const TERMINAL = new Set(["completed", "canceled", "cancelled", "duplicate"]);
export const STATE_TYPES = new Set(["triage", "backlog", "unstarted", "started", ...TERMINAL]);

// `list_issues` caps `description` at 500 characters and appends this marker.
// It is the one piece of good news about that cap: incomplete evidence is
// detectable, so the pass can say which judgments were made on a fragment
// instead of leaving the reader to guess.
export const TRUNCATION_MARK = "(truncated, use `get_issue` for full description)";

const lower = (s) => String(s ?? "").trim().toLowerCase();

/** `{name}` / `{id}` / plain string → string. */
const asName = (v) => (v && typeof v === "object" ? v.name ?? v.id ?? null : v ?? null);

/** `{value}` / plain number → number. Distinguishes absent from zero. */
const asValue = (v) => {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && typeof v.value === "number") return v.value;
  return null;
};

/** The human label the connector already resolved, e.g. "M" or "Urgent". */
const asDisplay = (v) => (v && typeof v === "object" && typeof v.name === "string" ? v.name : null);

export function normalizeIssue(issue) {
  const stateType =
    lower(issue.statusType) ||
    lower(typeof issue.state === "object" ? issue.state?.type : issue.stateType) ||
    (STATE_TYPES.has(lower(issue.status)) ? lower(issue.status) : "") ||
    (STATE_TYPES.has(lower(issue.state)) ? lower(issue.state) : "");

  return {
    raw: issue,
    id: issue.id,
    identifier: issue.identifier ?? issue.id,
    title: issue.title ?? "",
    description: issue.description ?? "",
    descriptionTruncated: (issue.description ?? "").includes(TRUNCATION_MARK),
    comments: (issue.comments ?? []).map((c) => c.body ?? c),
    stateName: asName(issue.status ?? issue.state),
    stateType,
    project: asName(issue.project),
    projectId: issue.project?.id ?? issue.projectId ?? null,
    milestone: asName(issue.projectMilestone ?? issue.milestone),
    milestoneId: issue.projectMilestone?.id ?? issue.milestoneId ?? null,
    cycle: asName(issue.cycle?.number != null ? String(issue.cycle.number) : issue.cycle),
    team: asName(issue.team),
    assignee: asName(issue.assignee),
    labels: (issue.labels ?? []).map(asName).filter(Boolean),
    // Linear stores "no priority" as 0, not null, so an unset check tests
    // truthiness. `priority` here is always a number or null, never an object.
    priority: asValue(issue.priority),
    priorityName: asDisplay(issue.priority),
    estimate: asValue(issue.estimate),
    estimateDisplay: asDisplay(issue.estimate),
    url: issue.url ?? null,
    createdAt: issue.createdAt ?? null,
    updatedAt: issue.updatedAt ?? null,
  };
}

export const daysSince = (iso) => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
};
