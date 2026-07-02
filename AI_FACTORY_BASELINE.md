# AI Factory Baseline — plan validation against the existing codebase

Verdict on the six-phase "AI Factory Enhancements" plan: **most of it already
exists**, some of it partially. Paperclip is not an agent dashboard missing a
factory layer; the factory layer is largely built. Building the plan as
written would duplicate large parts of it. Below: what exists, what is only
partial, and the two gaps that were built.

## How work flows today (plan Phase 0)

1. **Issue creation** — `POST /api/companies/:companyId/issues`
   ([server/src/routes/issues.ts](server/src/routes/issues.ts)), UI New Task
   form, board chat, routines (cron), and agent-created child issues.
   Statuses: backlog → todo → in_progress → in_review → done, plus
   blocked/cancelled ([server/src/services/issues.ts](server/src/services/issues.ts)).
2. **Assignment** — `assignee_agent_id` on issues; org chart is `agents.reports_to`.
   Agents delegate via child issues per their AGENTS.md execution contract.
3. **Wake-ups** — heartbeat service
   ([server/src/services/heartbeat.ts](server/src/services/heartbeat.ts)) plus
   `agent_wakeup_requests`; watchdogs (`issue_watchdogs`, `task-watchdogs.ts`)
   and productivity review police stalled runs.
4. **Cost tracking** — `cost_events` (tokens + cost_cents, already linked to
   `company_id`, `agent_id`, `project_id`, **`issue_id`**).
5. **Budget stops** — `budget_policies` (scopes: company / agent / project;
   warn % + hard stop) enforced in `budgets.getInvocationBlock`, which the
   heartbeat calls **before and during** every run.
6. **Agent output** — `issue_work_products` (typed, provider, url, review
   state, primary flag), `issue_attachments`, `assets`, `documents` with
   revisions, plus the company-wide Artifacts page.

## Phase-by-phase verdict

| Phase | Verdict | What already covers it |
|---|---|---|
| 1. Work intake queue | **Mostly exists** | Manual intake = New Task / `POST /issues` with board API keys (`board_api_keys`, hashed tokens). Routing = `backlog` status + CEO/CTO triage per AGENTS.md. Gap: webhook payload mapping + redelivery dedupe (built, see below). |
| 2. Outcome-based completion | **Partially covered** | Agent-authored `in_review` transitions are rejected without a real review path (approvals, `request_confirmation`, human reviewer, monitor — enforced in routes/issues.ts). Work products carry `review_state`; approvals + watchdogs + productivity review close most of the "fake done" hole. But this is process gating, not typed required deliverables: nothing today lets you declare "this issue must produce a pull_request" and blocks `done` until a work product of that type exists. Required-deliverables-by-output-type is **not enforced yet**; add it as a small check on the `done` transition if process gates prove insufficient. |
| 3. Artifact layer | **Fully exists** | `issue_work_products`, `issue_attachments`, `assets`, `company-artifacts.ts`, Artifacts UI page, upload script in the paperclip skill. Not built. |
| 4. Company memory | **Deferred — not solved** | No shared cross-agent memory store exists. Documents system (+ revisions, annotations) and shared company files give durable, human-editable shared state, and the CEO's para-memory-files skill defines a file-based convention — but there is no structured memory table, no automatic context injection, and no cross-agent recall. Deferred deliberately; revisit when file-based memory measurably fails. |
| 5. Execution sandbox | **Plumbing exists; isolation NOT verified** | The `SandboxProvider` interface, environment leases, `execution_workspaces` lifecycle (cleanup_reason, kill via run cancellation), and the ExecutionWorkspaceDetail UI all exist. However, the only registered provider is a **fake/no-op test provider** — no Docker or remote isolation is implemented. Local runs use `project_primary` (shared project dir) or `git_worktree` strategies: file-level separation on the same host and user, **not a security boundary**. Per-command `timeoutMs` exists only in the sandbox interface, not local execution (watchdogs/liveness cover runaway runs instead). Secrets are opt-in per agent via secret bindings rather than injected by default. Do not treat untrusted input as safely contained until a real provider lands. |
| 6. Cost & capacity | **Mostly exists** | Budgets with hard stop at company/agent/project scope; per-agent `maxConcurrentRuns`; Costs UI. Gap: per-issue spend cap (built, see below). Per-adapter global concurrency remains an open upstream issue; not first-order for a single-box deployment. |

## The two genuine gaps (built)

1. **Per-issue max cost** — `issues.max_cost_cents` (nullable). Enforced in
   `budgets.getInvocationBlock`, which already received `issueId` from both
   heartbeat call sites but ignored it. When the summed `cost_events` for the
   issue reaches the cap, the run is blocked with scope `issue` — same
   mechanism as existing budget hard stops.
2. **Webhook intake** — `POST /api/webhooks/intake/:companyId`, authenticated
   with an existing board API key. Accepts a generic payload
   (`{title, body?, priority?, sourceRef?}`) or a GitHub issue webhook shape,
   creates a `backlog` issue, and dedupes redeliveries via
   `issues.source_ref` (unique per company).

## Not building (per plan's own exclusions + validation)

CEO chat, SAP/Workday/Jira/Slack connectors, marketplaces, analytics, vector
search, SSO, UI redesign — and additionally phase 3 (fully exists), phase 2
(process gates cover it well enough for now), phase 4 (deferred), and
phase 5's real isolation provider (deferred; the fake provider and local
worktree strategies are not a security boundary).
