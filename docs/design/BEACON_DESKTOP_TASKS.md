# Beacon Desktop: Tasks module and the TaskBoard client API (BD-0 addendum)

Status: **draft for owner review** (2026-11-25), **reviewed by Beacon the same day**: Q-BD-20, 23, 24, 26, 27, 31 and
35 agreed with the facts recorded below (Q-BD-23 org and instance switches, Q-BD-24 `app` channel, Q-BD-27 realtime
wording, B-T8 erasure, the Beacon tasks row after BD-2). Docs only: nothing here is built yet, and no app id, repository
name, secret or release changes with it.

**Owner UX decision (2026-11-25): landing module.** On first launch the app opens on **Chat**; afterwards on the
**last-used module**; when a timer is running at launch it opens on **Time**, whatever was used last (§9).

**Owner UX decision (2026-11-25): timer placement.** Where the running timer shows is a setting: **title bar only**, or
**title bar + sidebar**. The **mini timer** also stays as a separate, always-available window (§9).

**Owner UX decision (2026-11-25): sidebar.** Sidebar density is a setting (**comfortable** or **compact**), and in
Chat the **project channels have their own section**, separate from the organisation's channels (main design §5).

This addendum extends [BEACON_DESKTOP.md](BEACON_DESKTOP.md) (Q-BD-1..19 accepted). The owner decided on 2026-11-25 that
Beacon Desktop has **three modules**: chat (on ChatKitBundle), **tasks (on TaskBoardBundle)** and time tracking (on
TimeTrackBundle), with a first-class, professional UX. Beacon's fixed requirements R1–R7
([§0 of the main design](BEACON_DESKTOP.md#0-fixed-requirements-from-beacon)) apply here unchanged. Open points are
Q-BD-20 onwards in [§10](#10-open-questions). **[Beacon]** marks questions that need Beacon's answer.

Sources read for this addendum (read-only): TaskBoardBundle `main` at **v3.1.0** (`docs/API.md`, `docs/openapi.yaml`,
`docs/ROADMAP.md`, `docs/design/CLICKUP_IMPORT.md`, `src/Api/**`, `src/Service/TaskCommands.php`,
`src/Transition/**`, `src/Link/**`, `src/Bridge/TimeTrack/**`), the TimeTrackBundle **2.2.0** build (device-flow scope
families, `ClientFamilyTokenAuthenticator`, `ClientContextPolicyInterface`) and the ChatKitBundle **2.4.0** build (client
API `/chat/v1`, `ChatClientPrincipalResolverInterface`, `ChatClientContextPolicyInterface`, `docs/API.md`). Beacon's
`BeaconTaskApiAuthenticator` and its Time tracking apps pages were checked for the Beacon-side items.

`https://beacon.example` is a placeholder for the Beacon instance.

## Table of contents

- [1. What TaskBoard already offers (3.1.0)](#1-what-taskboard-already-offers-310)
- [2. Decision: a new client API that wraps the existing operations](#2-decision-a-new-client-api-that-wraps-the-existing-operations)
- [3. Auth: the tasks scope family and the principal port](#3-auth-the-tasks-scope-family-and-the-principal-port)
- [4. API surface `/api/task-board/v1`](#4-api-surface-apitask-boardv1)
- [5. Permission filtering per reader (R2)](#5-permission-filtering-per-reader-r2)
- [6. Cross-module flows](#6-cross-module-flows)
- [7. Realtime and polling](#7-realtime-and-polling)
- [8. Server-side constraints: rate limits, worker mode, concurrency](#8-server-side-constraints-rate-limits-worker-mode-concurrency)
- [9. The Tasks module in the app](#9-the-tasks-module-in-the-app)
- [10. Open questions](#10-open-questions)
- [11. Phases and versions](#11-phases-and-versions)
- [12. Beacon work, item by item](#12-beacon-work-item-by-item)
- [13. Out of scope](#13-out-of-scope)

## 1. What TaskBoard already offers (3.1.0)

### 1.1 Domain

- **Boards** per project, team or tenant (a personal board is a tenant like any other); folders of boards.
- **Columns**: one ordered list per board, each column with a name, colour, icon or emoji, a type (`open`, `custom`,
  `done`, `closed`) and a *humans only* flag. Beacon's demo default is To do 📝, In progress 🚧, Review 👀, Done ✅.
  **Column sets** are named templates of columns (`ColumnSet`): applying one copies its columns into a board, so a
  board always has one current list of columns. The desktop reads the board's columns only.
- **Tasks**: title, Markdown description (rendered by the host's `TaskTextRendererInterface`), priority (`low`,
  `normal`, `high`, `urgent`), tags (free text, at most 20), colour, `startAt` / `dueAt` (date-times), estimate in
  minutes, readable number (`#123`, spec 214), revision (optimistic lock, 2.16), provenance (`created_by`,
  `updated_by`, `channel` `web` / `app` / `api` / `mcp`, `token_name`, 2.18).
- **Members** with roles `assignee`, `reviewer`, `stakeholder`, `watcher` (`TaskMemberRole`).
- **Subtasks** of any depth, optionally limited by `max_subtask_depth` (Beacon: 3–4 levels), with reparenting (2.20).
  **Checklists** are subtasks tagged `checklist:<name>` (decided: no separate table).
- **Links**: URL, merge request, pull request, issue, documentation, other, **host object** (Beacon issues and other
  Beacon objects through `TaskObjectLinkResolverInterface`) and attachment; dependencies (blocks, blocked by, related,
  duplicates).
- **Comments** with @mentions and edit (2.16); images inside comments and descriptions are host files (Beacon:
  `beacon-file:` Markdown images).
- **Questions** on a task (spec 242, 2.23): text, options, single or multiple choice, recipients, due date, answer with
  `version`; the UI badge "Waiting for answer".
- **Time**: `total_time_seconds` per task, kept from TimeTrack events; the TimeTrack bridge (`TaskBoardTaskDirectory`,
  `TimeTrackTaskTimerStarter`) lets the web task menu start a TimeTrack timer.

### 1.2 The Task API (spec 213, since 2.2)

TaskBoard already has a **stateless Bearer API** for scripts and agents, mounted by Beacon at `/api/tasks/v2`:

- **ClickUp-shaped** (`team` / `space` / `list` / `task`, millisecond date strings, priorities 1–4, page numbers of 100,
  `{err, ECODE}` errors), contract `docs/openapi.yaml` pinned by `ApiOpenApiTest` and a ClickUp contract test.
- **Personal tokens** only: the host's `TaskApiRequestAuthenticatorInterface` (Beacon: `BeaconTaskApiAuthenticator`,
  `bt_` tokens) returns a `TaskApiPrincipal {user, level, where, tokenId, tokenName, channel}`. Levels `my_tasks`,
  `read`, `tasks`, `full` (not a chain, `TaskApiCapability::allows()`); `TaskApiWhere` = everything, or a list of
  tenants and boards. Behind a **stateless firewall whose security user is the token's user** (the access checkers read
  the security token).
- **Guard** (`TaskApiGuard`): out of reach → 404 `ACCESS_001` (always the same), plan → 403 `PLAN_001`, level → 403
  `TOKEN_001`, person → 403 `ACCESS_002`.
- **Writes through the UI's services**, with revisions and `If-Match` (409 `TASK_409` + `current_revision`),
  `Idempotency-Key` (24 h, scoped to the token, `task_board_api_idempotency`), lock conflicts as `CONFLICT_001` /
  `CONFLICT_002` (transaction-doctrine), atomic bulk updates, the column transition policy (`HumansOnly…`, Beacon's
  `WIP_LIMIT`), questions, checklists, time entries (never deleted).
- **In-process operations** (`Api\Operation\TaskApiReadOperations`, `TaskApiTaskOperations`,
  `TaskApiChecklistOperations`, `TaskApiQuestionOperations`, `TaskApiTimeOperations`), used by Beacon's MCP server with
  `channel: mcp`. Framework-free commands (`Service\TaskCommands::moveTask($actor, $taskId, $columnId, $position,
  $expectedRevision)`) since 2.15.

### 1.3 What is missing for a desktop client

| Need | Today | Gap |
|---|---|---|
| Device-flow token, `tasks` family, revocable per device | Personal `bt_` tokens created in the account UI | No device flow, no family; level and where come from the token form |
| Explicit tenant per request (R4) | `where` fixed in the token | No context header |
| "My tasks" today / upcoming / overdue | `GET /v2/team/{id}/task?assignees[]=&due_date_lt=` per team | No cross-team "mine" query with date buckets |
| Board page (columns with their cards) | `GET /v2/list/{id}/task` (100 per page, page numbers, `statuses[]`) | No per-column cursor paging |
| Text safe for a text-only DOM, references filtered per reader (R2) | Raw Markdown; images show alt text and file UUID to an API reader ("Known differences from the UI"); host-object link labels and URLs are not asked per viewer (`TaskObjectLinkResolverInterface::label()` has no viewer) | No structured body, no per-reader reference rendering |
| Realtime | None. **Live board refresh is on the roadmap ("Next")**, decided yes by the owner on 2026-11-18 (no cursors) | No publisher, no topic |
| Desktop moves counted as a person | Channels `web`, `api`, `mcp`, `import`; *humans only* refuses `api` / `mcp` | A desktop channel (`app`) the transition policy treats as a person |

## 2. Decision: a new client API that wraps the existing operations

**Recommendation (Q-BD-21): a new versioned client API, `<prefix>/task-board/v1` (Beacon: `/api/task-board/v1`), built
as a thin facade over the existing `Api\Operation` services and `TaskCommands`.** It reuses every rule (guard, access
checkers, plan gate, transition policy, revisions, idempotency store, audit event, history, notifications); it adds no
second copy of any rule. What it adds is the desktop's shape: cursors, buckets, structured text, per-reader references,
the device-flow principal and realtime.

Why not point the desktop at `/api/tasks/v2`:

- its shape is ClickUp's on purpose (pinned by a contract test); bending it for a desktop would break that promise;
- its raw Markdown breaks R2 for a client (file UUIDs, unfiltered host-object labels);
- its authentication is the personal-token model (level and where chosen in a form), not a device family with an
  explicit context per request;
- D-20261110-04 wants client APIs under `/api/<bundle>/v<N>`; `v2` there is ClickUp's version, kept for compatibility.

`/api/tasks/v2` stays as it is for scripts, agents and the MCP server.

## 3. Auth: the tasks scope family and the principal port

### 3.1 Scope family and scope names

TimeTrackBundle 2.2.0 lets hosts register scope families (`DeviceScopeFamilyProviderInterface`); Beacon registers
`chat` for BD-2 and registers **`tasks`** for this module. One token per family, deny by default, revocable per family,
audited per family, and `ClientFamilyTokenAuthenticator` refuses a token of another family (a `tasks` token never opens
`/api/chat/v1` or the time API, and the other way round).

**Scope name collision.** The `time` family already owns **`tasks:read`** (`ClientScope::TasksRead`: the timer's task
picker, `GET /api/time-track/tasks`, subject search). `DeviceScopeFamilyRegistry` refuses a scope that belongs to two
families (`LogicException` at the first request). Renaming the time scope would break every installed client. So the
`tasks` family uses scope names after its API segment (Q-BD-20):

| Family key | Label | Scope | Label on the approval page | Opens |
|---|---|---|---|---|
| `tasks` | Tasks | `task-board:read` | See your boards and tasks | every `GET` of `/api/task-board/v1`, `GET realtime`, `GET changes` |
| `tasks` | Tasks | `task-board:write` | Create and change tasks, comment, answer questions | every write of `/api/task-board/v1` |

Both match `DeviceScopeFamily::SCOPE_PATTERN` (Q-BD-20, agreed by Beacon). The app asks for both and both are checked on
the approval page (Q-BD-23, agreed).

**Switches (Beacon, Q-BD-23).** The `tasks` family respects the same two switches as today's `bt_` tokens: the instance
switch `TASK_API_ENABLED` (`TaskApiSettings`) and the organisation switch `BillingAccount::$taskApiAllowed` (column
`task_api_allowed`). Instance switch off → the client API answers as if off (`404`); an organisation with
`task_api_allowed = false` is left out of the context list and of every `where` (a request naming it is
`403 context_forbidden`). A future "allow desktop app" switch becomes a second boolean next to `task_api_allowed`; no new
policy type is needed.

### 3.2 From scopes to a TaskBoard principal

The v1 facade builds a `TaskApiPrincipal` per request, so the existing guard and operations decide everything:

| Token holds | `TaskApiLevel` | Notes |
|---|---|---|
| `task-board:read` only | `Read` | Reads everything the person can see in the context; writes 403 `insufficient_scope` before the guard |
| `task-board:read` + `task-board:write` | `Tasks` | Creates, edits, moves, assigns, comments, answers, checklists, where the **person** may (the guard's `ACCESS_002` still applies) |
| — | never `Full`, never `MyTasks` | Board and column management stay in the web app (§13) |

`where` comes from the **context** (R4): the host's context policy turns `personal` or `org:<uuid>` into tenant keys
(`TaskApiWhere::limitedTo($tenantKeys, [])`), re-checked on every request. `channel` is **`app`** (new constant), the
`tokenName` is the host's label of the device ("Beacon Desktop · Work laptop"). Provenance then shows `channel: app`,
which TaskBoard already lists as a value (2.18).

### 3.3 The principal port: the ChatKit shape, plus a bundle authenticator

**Recommendation (Q-BD-22): per-bundle ports with exactly ChatKit 2.4's shape now; one shared contract package later,
when a third bundle needs the same port.**

```text
Nowo\TaskBoardBundle\ClientApi\Contract\TaskClientPrincipalResolverInterface
    resolve(string $bearer, TaskClientRequest $request): ?TaskClientPrincipal
TaskClientPrincipal { object $user, list<string> $scopes, string $tokenId, string $tokenName, ?string $contextKey }

Nowo\TaskBoardBundle\ClientApi\Contract\TaskClientContextPolicyInterface
    contextsFor(TaskClientPrincipal $p): list<TaskClientContext>          // GET me, switcher
    allows(TaskClientPrincipal $p, string $contextKey): bool              // every request
    whereFor(TaskClientPrincipal $p, string $contextKey): TaskApiWhere    // tenants of the context, every request
```

Same semantics as `ChatClientPrincipalResolverInterface` / `ChatClientContextPolicyInterface`: called once per request,
never cached, `null` for any token that is not a valid `tasks` token now (unknown, expired, revoked, other family);
`KEY_PATTERN` for token ids and context keys; context header `X-Beacon-Context` (`client_api.context_header`);
`includes()` is replaced by `whereFor()` because TaskBoard already narrows by tenant.

One difference from ChatKit, forced by TaskBoard: its access checkers read the **security token**, so the API cannot
run with `security: false`. TaskBoard therefore ships a **Symfony authenticator**
(`nowo_task_board.client_api.authenticator`, stateless, `AbstractAuthenticator`) that the host adds to a stateless
firewall on `^%nowo_task_board.client_api.v1_path_prefix%/`. It calls the resolver **once**, sets the token user as the
security user, and puts the principal in a request attribute (`_nowo_task_board_client`); a failure answers the API's own
`401 invalid_token` (never a redirect). The guard compares the security user with the principal's user by id, as the
Task API does.

**Beacon implements both ports with one generic adapter** over TimeTrack's `ClientFamilyTokenAuthenticator`
(`authenticate('tasks', $authorization, $requiredScope, $clientIp, $contextHeader)`), the same adapter that serves chat
with `'chat'`: per-IP limit, token, account status, credential state, per-token limit, family, scope and context are
checked there, in that order, and every refusal is audited with the family. No rule is copied.

Alternatives: (B) extract `nowo-tech/client-api-contract` now (`ClientPrincipal`, resolver, context policy) and adopt it
in ChatKit 2.5 and TaskBoard 3.4: cleaner long-term, but it adds a package, a dependency on both bundles and a ChatKit
change to an API that is in audit; (C) reuse `TaskApiRequestAuthenticatorInterface`: one hook for two very different
credentials, and the context header would leak into the personal-token API. Record the extraction as a dedup candidate
for the next dedup survey (owner rule).

### 3.4 Approval, revocation, storage

- Device flow as in the main design §4.2: one family per flow; the app chains "Connect tasks too?" after chat (or after
  time). The approval page (Beacon, 2FA re-auth) names the family "Tasks" and lists the two scopes.
- Keychain: service `tech.nowo.time-track-desktop`, user **`tasks-token`** (third entry). Only Rust reads it.
- Sign out revokes and deletes the three tokens; "Disconnect tasks" deletes only the tasks token; a `401 invalid_token`
  on the tasks API disconnects tasks only.
- On revocation (or account erasure) Beacon also calls TaskBoard's `TaskApiIdempotencyStoreInterface::forget()` with the
  token's scope, so no stored answer (which can hold task text) outlives the token.

## 4. API surface `/api/task-board/v1`

### 4.1 Conventions

- **Off by default**: no route until `client_api.principal_resolver` is set (as ChatKit). OpenAPI 3.1 in
  `docs/openapi/task-board-client-v1.yaml`, kept in step with the routes by a test; human doc `docs/CLIENT-API.md`.
- **Stateless**: Bearer only; cookies, sessions and CSRF ignored; `Cache-Control: no-store, private`; no CORS.
- **Context**: `X-Beacon-Context: personal` or `org:<uuid>` on every request (required unless the token is bound to one).
  Unknown, revoked or foreign context → `403 context_forbidden` (one answer).
- **Ids** are the bundle's UUIDs (strings); people are the host's public ids. **Dates** are RFC 3339 with offset (UTC
  `Z` in answers); `dueAt` / `startAt` carry `allDay: true` when the time part is the bundle's "date only" marker.
- **Cursors** are opaque base64url (`v1.<sort key>.<id>`, as `ChatClientCursor`), `limit` 1–100, `nextCursor: null` at
  the end. A page may hold fewer rows than `limit` when rows it scanned are not visible.
- **Errors**: `{ok: false, error: <code>}` like ChatKit's client API (not the Task API's `ECODE`), plus fields where
  noted. Out of reach, unknown and out-of-context ids are all `404 not_found`.
- **Writes**: `Idempotency-Key` **required** on every `POST` that creates something (task, comment, question, answer,
  checklist item); `If-Match: "<revision>"` **required** on every change of an existing task (Q-BD-29). The answer of a
  write carries the new `ETag`.

### 4.2 Read routes (`task-board:read`)

| Method and path | Answer and notes |
|---|---|
| `GET me` | `{apiVersion, user {id, name, initials, avatarUrl}, scopes, context, contexts[{key, label}], features {realtime, questions, timeTracking, taskNumbers, templates, subtaskDepth, files}, limits, enums {priorities, memberRoles, columnTypes}}` |
| `GET my-tasks?bucket=&today=&cursor=&limit=` | The caller's tasks as **assignee** in the context's boards, open columns only. `bucket` = `overdue` (due before `today`), `today`, `upcoming` (next 14 days), `no_date`, `review` (caller is **reviewer** and the task sits in a column the board marks as review, else any open column), `all`. `today` is the client's local date (`YYYY-MM-DD`, ±1 day of server UTC, else `400 invalid_date`). Sorted by due date, priority, number. Each row is a **task card** (§4.4). First page also returns `counts {overdue, today, upcoming, review}` |
| `GET boards?cursor=&limit=&q=` | Boards of the context the caller may view, grouped by `group {type: project\|team\|personal\|folder, id, label}`, each `{id, title, icon, color, archived:false, columns[{id, name, color, icon, type, humansOnly, wipLimit?}], counts {open}, permissions {canCreate, canMove}}`. Archived boards are left out |
| `GET boards/{id}` | One board with its columns, members' avatars (for the assignee picker), tags in use (top 50), templates the caller may use (`features.templates`) |
| `GET boards/{id}/tasks?column=&cursor=&limit=&assignee=&priority=&tag=&q=&due=&parent=` | **Board page.** With `column`: that column's top-level cards in board order (position) — the kanban loads each column lazily, 30 by default. Without `column`: the list view, `sort` = `position` (default), `due`, `priority`, `updated`, `number`. `assignee=me`, `priority` (repeatable), `tag` (repeatable), `due` = `overdue\|today\|week\|none`, `q` (words in title or description, the Task API's search rules and `search.max_matches`), `parent=<id>` for one task's subtasks |
| `GET tasks/{id}` | **Task detail** (§4.5), `ETag: "<revision>"`. `?number=123&board=<id>` (or `#123` URL-encoded) looks a task up by its number, as the Task API's `custom_task_ids` |
| `GET tasks/{id}/subtasks?cursor=` | One level of subtasks (cards with `subtaskSummary`), board order; the app expands level by level up to `features.subtaskDepth` |
| `GET tasks/{id}/comments?before=&limit=` | Newest first, 20 by default; each `{id, author {id, name, initials}\|null, body (tokens/1), createdAt, editedAt, canEdit}` |
| `GET tasks/{id}/questions?state=` | Questions as the Task API's shape, with `context` as tokens/1 and `waitingForMe` per question |
| `GET tasks/{id}/activity?before=&limit=` | Optional (`features.activity`, BD-4): the history rows the web panel shows, as plain text lines |
| `GET questions/waiting` | Open questions where the caller is a recipient, in the context (the "Waiting for answer" inbox), 100 at most |
| `GET people?q=&board=` | People the caller may assign on that board (prefix match, 20 at most), as the Task API's member lookup |
| `GET realtime` | `{enabled, hubUrl, token, topic, expiresAt, events}` (§7); counts as a read |
| `GET changes?since=&limit=` | Polling fallback (§7.3) |

### 4.3 Write routes (`task-board:write`)

| Method and path | Body | Notes |
|---|---|---|
| `POST tasks` | `{boardId, columnId?, title, description?, priority?, dueAt?, startAt?, allDay?, estimateMinutes?, tags?, assignees? ("me" or ids), parentId?, templateId?, source?}` | **Quick create.** `Idempotency-Key` required. Default column: the template's, else the first. `source` (§6.2). `201 {task}` + `ETag`. Plan limits as the UI (`QUOTA_CHECK`) → `403 plan_limit` with the host's reason |
| `PATCH tasks/{id}` | any of `title`, `description`, `priority`, `color`, `tags` (the whole list), `dueAt`, `startAt`, `allDay`, `estimateMinutes`, `archived` | `If-Match` required. A field not listed is `400 invalid_field` (no silent warnings for a first-party client). `200 {task}` + new `ETag` |
| `POST tasks/{id}/move` | `{columnId, beforeTaskId?, afterTaskId?}` | **Move between and within columns.** `If-Match` required for a column change; a reorder inside the same column is last-writer-wins (TaskBoard does not bump the revision on a reorder) and accepts `If-Match: *`. Goes through `TaskCommands::moveTask()` and the column transition policy (operation `move`, channel `app`): done column completes, leaving it reopens; `WIP_LIMIT`, *humans only* and the host's own codes come back as `403 transition_refused {policyCode, message}` |
| `PUT tasks/{id}/members/{userId}` / `DELETE …` | `{role: assignee\|reviewer\|stakeholder\|watcher}` | The assignee policy and the person's right apply; `If-Match` required |
| `PUT tasks/{id}/parent` | `{parentId\|null}` | Reparenting with the 2.20 rules (`PARENT_00x` → `409 parent_refused {reason}`); BD-4 |
| `POST tasks/{id}/checklist-items` | `{checklist, title}` | A checklist item (a subtask tagged `checklist:<name>`); `Idempotency-Key` required |
| `PATCH tasks/{id}/checklist-items/{itemId}` | `{title?, done?}` | `If-Match` of the **item** (it is a task). `done` moves it to the done column or back to the first (the Task API's `resolved`) |
| `POST tasks/{id}/subtasks` | as `POST tasks`, board = the parent's | Within `max_subtask_depth` (`409 parent_refused {reason: too_deep}`) |
| `POST tasks/{id}/comments` | `{body}` (Markdown, ≤ 10 000 characters) | `Idempotency-Key` required. Mentions from `@Label` as the UI; `201 {comment}` |
| `PATCH comments/{id}` | `{body}` | The host's `comment_edit_policy` (default: its author) |
| `POST tasks/{id}/questions` | the Task API's question body | BD-4; recipients from `GET people` |
| `POST questions/{id}/answer` | `{options, otherText?, version}` | `version` required; a racing answer → `409 conflict {currentVersion}` |
| `POST questions/{id}/withdraw` | `{reason, version}` | Asker or manager only |

**Not in v1**: delete a task (archive instead, Q-BD-37), board and column management, dependencies and links editing,
custom field values, attachments upload, time entries (time goes through the TimeTrack client API, §6.1), bulk updates.

### 4.4 Task card (lists and board columns)

```json
{
  "id": "9c1f…", "number": 123, "title": "Fix the login redirect",
  "boardId": "4be0…", "column": {"id": "c2…", "name": "In progress", "icon": "🚧", "type": "custom"},
  "priority": "high", "color": null, "tags": ["auth"],
  "startAt": null, "dueAt": "2026-11-27T00:00:00Z", "allDay": true,
  "assignees": [{"id": "u-…", "name": "Ana", "initials": "AN", "avatarUrl": null}],
  "subtaskSummary": {"total": 4, "done": 1}, "checklistSummary": {"total": 3, "done": 3},
  "openQuestions": 1, "waitingForMe": true, "comments": 5,
  "estimateMinutes": 120, "timeSpentMinutes": 95,
  "revision": 41, "updatedAt": "2026-11-25T10:12:03Z"
}
```

`avatarUrl` is a same-origin URL the app fetches through Rust (pinned client), or `null`.

### 4.5 Task detail

The card plus: `description` (tokens/1, §5.2), `parent {id, title, visible}` (or `{visible: false}`), `members[{user,
role}]`, `checklists[{name, items[{id, title, done, revision}]}]`, `links[{type, url, title, visible}]`
(`merge_request`, `pull_request`, `issue`, `url`, …; host objects per reader, §5.3), `dependencies[{type, task {id,
number, title, visible}}]`, `questions {open, waitingForMe}`, `createdBy`, `updatedBy`, `channel`, `createdAt`,
`permissions {canEdit, canMove, canComment, canAssign, canAsk, canTrackTime}`, `webUrl` (Open in Beacon).

### 4.6 Errors

| Status | Codes |
|---|---|
| 400 | `invalid_context`, `context_required`, `invalid_cursor`, `invalid_limit`, `invalid_json`, `invalid_field` (`field`), `invalid_date`, `search_too_broad` |
| 401 | `invalid_token` (+ `WWW-Authenticate: Bearer`) |
| 403 | `insufficient_scope` (+ `WWW-Authenticate`), `context_forbidden`, `forbidden` (the person may not), `plan_limit` (`reason`), `transition_refused` (`policyCode`, `message`) |
| 404 | `not_found` (unknown, foreign, out of context, archived board) |
| 409 | `conflict` (`currentRevision`, and `task` when the reader may still see it), `parent_refused` (`reason`), `idempotency_mismatch`, `idempotency_in_flight`, `unavailable` (`code: CONFLICT_001`, + `Retry-After`), `partial` (`code: CONFLICT_002`, no `Retry-After`: read again) |
| 428 | `precondition_required` (`If-Match` missing on a change) |
| 429 | `rate_limited` (+ `Retry-After`) |
| 503 | `audit_unavailable` (no `API_WRITE` listener), `idempotency_unavailable` |

Every refusal from authentication on dispatches a `TaskClientApiDeniedEvent` (ids and codes only: reason, token id,
user public id, `/24` or `/64` prefix), like ChatKit's.

## 5. Permission filtering per reader (R2)

### 5.1 Lists and single objects

- Every list is narrowed by the context's `where`, then by the person's access (`canViewBoard()`, `canViewTask()`,
  `BOARD_ACCESS_CHECK` / `TASK_ACCESS_CHECK` listeners), **before** paging: a task the reader cannot open is not in any
  page, count or bucket.
- Subtasks, parent, dependencies and links to other tasks are shown only when the reader may open the other task;
  otherwise `{visible: false}` with no id, number or title (the Task API already hides them; v1 makes the placeholder
  explicit).
- Members are listed as the Task API lists them (people the host shows); e-mail is never sent.

### 5.2 Text: tokens/1, shared with chat

Descriptions, comments and question contexts are returned as **`{format: "tokens/1", blocks: [...]}`**, the same format
ChatKit 2.4 uses for message bodies (Q-BD-16, accepted): blocks `paragraph`, `quote`, `list`, `code`, `heading`
(new, levels 1–3, for task descriptions), `rule` (new); tokens `text` (+ `bold`, `italic`, `strike`), `break`, `code`,
`mention`, `link` (`http(s)` / `mailto` only), `reference`, and **`image`** (new). The app renders every string as a
text node; no HTML ever reaches the web view. A **task list** in Markdown (`- [ ]`) is a `list` with `checked` per item
(read-only in v1).

- `reference`: Beacon objects named in the text (issues, tasks, wiki pages, monitors) are resolved **for the reader**
  through a host port (`TaskClientReferenceResolverInterface`, Beacon reuses the reference rules its chat uses). Not
  visible → `{type: "reference", visible: false, text: "Content not visible"}`. References inside code are never
  resolved.
- `image` (a `beacon-file:` image): `{type: "image", visible, fileId?, alt?, width?, height?}`. Not visible → no id, no
  alt. Phase BD-3 shows a neutral "Image — open in Beacon" card; from BD-4 the app fetches
  `GET files/{fileId}` which answers `302` to a short-lived signed URL after the host's access check (host port
  `TaskClientFileResolverInterface`), fetched through Rust, never cached on disk (Q-BD-26).
- **Implementation (Q-BD-25)**: the format is specified once (a JSON schema and a fixture set in ChatKit's
  `docs/API.md` and TaskBoard's `docs/CLIENT-API.md`, identical); TaskBoard ships its own converter over its Markdown
  rules (the same CommonMark subset its renderer accepts). A shared `rich-text-tokens` package is a dedup candidate,
  not a prerequisite.

### 5.3 Host-object links (Beacon issues and others)

`TaskObjectLinkResolverInterface::label()` / `url()` / `badge()` take no viewer today. v1 needs a viewer-aware port
(`TaskObjectLinkVisibilityInterface::visibleTo(object $viewer, string $type, string $id): bool`, optional; without it
every host-object link reads `{visible: false}` in v1 — deny by default). Beacon implements it for issues, chat messages
(§6.2), wiki pages and monitors with its existing voters.

### 5.4 Notifications

Task notifications on the desktop (Q-BD-32) carry **no task text by default** ("New activity in Beacon · Tasks"); the
preview level and organisation cap of the main design (§3.4, Q-BD-9) apply, and the content comes from a server preview
(`GET notifications/preview/{id}`), never from a realtime payload.

## 6. Cross-module flows

### 6.1 Start a timer from a task

- The task card and detail show **Start timer** when the app holds a time token and `permissions.canTrackTime` is true
  (TaskBoard's `canTrackTime()` — the same decision `POST /v2/team/{id}/time_entries` with `tid` uses; TimeTrack still
  decides).
- The app calls TimeTrack's existing client API with the **time** token: `POST /api/time-track/v1/timer/start {taskId}`
  (or `timer/switch` when a timer runs, after the user confirms "Switch from <task>?"), same `X-Beacon-Context`.
  TimeTrack checks the task through TaskBoard's `TaskBoardTaskDirectory` (`canTrackTask()`), the period lock and
  allocation rules; `409 period_locked` / `400 invalid_request` are shown as TimeTrack answers them. No new server code.
- The running timer (from `GET /api/time-track/v1/timer`) marks its task in every task view (a ticking badge);
  `timeSpentMinutes` refreshes after `timer/stop` (TaskBoard's `total_time_seconds` updates from TimeTrack's events).
- No token can open the other family's API: the tasks API never starts a timer, the time API never edits a task.

### 6.2 Create a task from a chat message

1. In Chat, the message menu offers **Create task** (when the tasks token exists and the context has a board the person
   may create in).
2. The app pre-fills the quick-create sheet from what it already displays: title = the message's first line (plain text
   of tokens/1, ≤ 120 characters), description = a quote block of the message text (references the reader could not
   see stay "Content not visible"), board = last used in this context, column = first, assignee = me. The user edits
   and confirms.
3. `POST /api/task-board/v1/tasks` with `source: {type: "chat_message", conversationUuid, messageUuid}` and an
   `Idempotency-Key` derived from the message uuid (a double click creates one task).
4. TaskBoard asks the host port `TaskClientSourceLinkInterface::link($principal, $source)`; Beacon checks that **this
   person can read that message now** (ChatKit's access rules) and answers a host-object link `chat_message:<uuid>`, or
   refuses (`422 source_not_visible`, the same answer for an unknown message). Without the port `source` is
   `400 invalid_field`. The task gets the link; other readers see it through §5.3 (`visible: false` if they cannot read
   the message).
5. Optional, **off by default** (Q-BD-30): with a chat token holding `chat:write` (BD-3+), the app posts a reply
   "Task #123 created" with a task reference in the conversation — through the chat API, as the user.

Reverse direction: a task `reference` in a chat message opens the task inside the Tasks module when the tasks token
exists, else "Open in Beacon".

## 7. Realtime and polling

### 7.1 Today

TaskBoard has **no** realtime and no publisher. Live board refresh is on its roadmap ("Next") and the owner accepted it
on 2026-11-18 (refresh yes, multi-user cursors no). **Beacon's web has no live board refresh either** (Beacon,
2026-11-25). What Beacon has: task **notifications** pushed by `TaskNotificationListener` through
`MemberIssueRealtimeNotifierInterface` (Mercure, private per-user topic), on its hub (`ConfiguredMercure`, also used by
chat and wiki collaboration).

### 7.2 Design: an ids-only change port, delivered like Beacon's task notifications (Q-BD-27)

- TaskBoard 3.5.0 adds **`TaskBoardChangePublisherInterface`** (optional; default no-op): after commit (Beacon runs
  `events.after_host_commit: true`), the bundle sends one `TaskBoardChange {kind, boardId, taskId?, revision?, at}` per
  write it already turns into an event (`task.created`, `task.updated`, `task.moved`, `task.archived`, `task.erased`,
  `task.comment`, `task.question`, `task.members`, `board.columns`). **Ids only**: no title, text, name or column name.
- **Beacon fans out** (Messenger, async, batched and debounced per board for 2 s) the same way it already delivers task
  notifications (`MemberIssueRealtimeNotifierInterface`: Mercure, private per-user topic): the recipients are the people
  who may view the board (for `task.*` also checked with `canViewTask()` when the host has task-level grants), each on
  **their own** private topic (R1); for the desktop token a tasks-only topic `/nowo-task-board/users/<publicId>`, so a
  `tasks` token never subscribes to anything else (R3).
- **Web live board refresh is new Beacon work, not reuse** (B-T11): once the port exists, Beacon's board page can
  subscribe to the same hints over SSE. It is optional for the desktop and can land after it.
- `GET realtime` (tasks API) returns `{enabled, hubUrl, token, topic, expiresAt, events}` from Beacon's transport
  (`BeaconTaskRealtime` over `ConfiguredMercure`): subscriber JWT for that topic only, subscribe-only, 15 minutes.
  `my_tasks` events (`{kind: "mine", taskId}`) go to a person whose assignment or reviewer role changed.
- Client (Rust, as chat §3.3): SSE with the JWT in the `Authorization` header (Q-BD-12), refresh ~2 minutes before
  expiry, `Last-Event-ID` on reconnect, **events are hints**: refetch `tasks/{id}` or the open column page; never render
  a payload.
- **Two streams** (chat and tasks), one per family and token (Q-BD-28): a combined JWT would let one family's token open
  the other's topic. Two SSE connections are well within budget.

### 7.3 Polling fallback (hub off, SSE blocked, or before 3.5.0)

- `GET changes?since=<cursor>&limit=200` returns `{changes: [{taskId, boardId, revision}], nextCursor, reset}`: tasks in
  the context the reader may open whose `updatedAt` (and id) passed the cursor; `reset: true` when the cursor is older
  than 24 h or more than `limit` changed — the app then reloads the open view. Erased tasks are not listed (no
  tombstones): the open board reloads every 10 minutes anyway.
- Cadence: open board or task every 20 s while visible, My tasks every 60 s, 5 min in the background; exponential
  backoff with jitter up to 10 min; `Retry-After` honoured; SSE retried every 10 min. Budget: far under the per-token
  limit.

## 8. Server-side constraints: rate limits, worker mode, concurrency

- **Rate limits.** Before TaskBoard sees the request, TimeTrack's family authenticator applies the per-IP (300/min) and
  per-token budgets (Beacon: **120/min** for the `tasks` family, a board session with drag and drop needs more than
  chat's 60). TaskBoard's `TaskApiRateLimiterInterface` hook adds the person's write budgets, shared with their personal
  tokens: writes 120/min, creates 30/min, comments 30/min, search 30/min. `429 rate_limited` + `Retry-After`. Limiters
  in the shared cache pool (Redis) across workers.
- **Worker mode (R7, REQ-RUNTIME-002).** FrankenPHP, kernel not reset: the principal is resolved per request and lives
  in a request attribute; the context and `where` are request data, never service state; reference, visibility and
  people lookups are memoised per request only; no static caches. Worker test like `ChatClientApiWorkerTest`: one
  kernel, 500 rounds, two people in two contexts, a board grant flipped every round, a token revoked half-way, a
  membership removed, flat memory.
- **Concurrency (REQ-RUNTIME-003).**
  - Field changes and column moves: `If-Match` compared on the locked row (`SELECT … FOR UPDATE`), database-incremented
    revision (2.17), so two devices never overwrite each other silently: the loser gets `409 conflict` with the current
    revision and, when still visible, the current task.
  - Reorders inside a column are last-writer-wins by design (no revision bump), documented.
  - Checklist toggles change the item's own revision; answers carry the question `version` (`409` on a race).
  - Creates and comments: `Idempotency-Key` required, the bundle's store (claim, 24 h, `IDEMP_00x` mapped to
    `idempotency_*`); a replay re-checks reach.
  - Lock conflicts anywhere in the chain → `409 unavailable` (`CONFLICT_001`, `Retry-After`) or `409 partial`
    (`CONFLICT_002`, read again), transaction-doctrine's policy as the Task API.
  - Realtime publishes and fan-out only after commit; fan-out idempotent per change id (a redelivered message publishes
    the same hint, harmless).
- **Audit.** Every write dispatches `API_WRITE` with `channel: app` (Beacon's audit listener exists; without it `503
  audit_unavailable`). Token use is audited by TimeTrack's auditor with `family: tasks` (Beacon's
  `ClientApiAuditSubscriber`).

## 9. The Tasks module in the app

The clickable prototype (built in parallel) fixes the visuals; this section fixes behaviour and data only.

- **Navigation.** The shell gets three top-level modules — **Time**, **Chat**, **Tasks** — (`Ctrl/Cmd+1..3`), each
  shown only when its token exists ("Connect tasks" card otherwise). One context for the whole app (main design §4.4).
- **Landing module (owner decision 2026-11-25).** First launch: **Chat**. Later launches: the **last-used module**
  (stored per device in settings). A timer running at launch wins: the app opens on **Time**. A module whose token is
  missing falls back to its "Connect" card in place, never to another module silently.
- **Timer placement (owner decision 2026-11-25).** A setting per device: the running timer shows in the **title bar
  only**, or in the **title bar and the sidebar**. Either way the **mini timer** stays available as its own window
  (always available, independent of the main window and of the module shown). The task card's ticking badge (§6.1) is
  shown in both modes.
- **Sidebar density (owner decision 2026-11-25).** A setting per device, **comfortable** or **compact**; it applies to
  every module's sidebar (Tasks: boards and My tasks sections).
- **My tasks** (landing view): sections *Overdue*, *Today*, *Upcoming*, *No date*, *To review*, with counts; a card per
  task (§4.4); inline actions: complete (move to the done column), start timer, open.
- **Boards**: picker grouped by project / team / personal; **kanban** with lazy columns (30 cards, "Load more"), column
  header with count, colour, icon and WIP limit; **list** view with sort; filters (assignee = me, priority, tag, due,
  text) kept per board on the device.
- **Drag and drop** (mouse and keyboard: `Space` to pick, arrows to move, `Space` to drop, `Esc` to cancel, announced in
  a polite live region). Optimistic move; on `409 conflict` the card goes back with "Changed by someone else — reloaded";
  on `403 transition_refused` the policy's message is shown.
- **Task detail** as a side panel (wide window) or full view (compact window): inline edit of title, description
  (plain-text editor, Markdown, preview from the server's tokens), priority, dates, estimate, tags, members; checklists;
  subtasks tree (expand per level); comments; questions with *Answer*; links; "Open in Beacon".
- **Quick create** (`Ctrl/Cmd+N` in Tasks, also from the tray): title, board, column, due, priority, assignee; Enter
  creates, the sheet stays for the next one.
- **Accessibility and i18n**: WCAG 2.1 AA as the rest of the app; priority and due state not by colour alone; reduced
  motion; en and es for every string.
- **Local data**: task data in memory only, cleared on context switch and sign-out (as chat Q-BD-15); per-board view
  settings (filters, last view) in settings storage; no offline write queue in v1 (a failed write shows *Retry*, the
  `Idempotency-Key` / `If-Match` make it safe).

## 10. Open questions

**[Beacon]** = Beacon's answer needed; the rest are the owner's.

| Id | Question | Options | Recommendation |
|---|---|---|---|
| **Q-BD-20** **[Beacon]** ✔ agreed | Scope names of the `tasks` family (`tasks:read` already belongs to the `time` family) | A: `task-board:read` / `task-board:write` · B: rename the time scope (breaks installed clients) · C: allow one scope in two families (TimeTrack change, weaker checks) | **A** (matches the API segment; no change to TimeTrack 2.2.0) |
| **Q-BD-21** | Desktop on the existing `/api/tasks/v2` or a new `/api/task-board/v1`? | A: new v1 facade over the existing operations · B: extend `/api/tasks/v2` | **A** (ClickUp shape stays pinned; v1 adds context, cursors, tokens/1, per-reader links, realtime without copying rules) |
| **Q-BD-22** | Principal port | A: TaskBoard port with ChatKit's shape + a bundle Symfony authenticator; Beacon's one generic adapter over `ClientFamilyTokenAuthenticator` serves both · B: shared `client-api-contract` package now · C: reuse `TaskApiRequestAuthenticatorInterface` | **A**; B recorded as a dedup candidate for when a third bundle needs it |
| **Q-BD-23** **[Beacon]** ✔ agreed | Level, defaults and switches | A: `read` → Read, `read`+`write` → Tasks, both checked on the approval page · B: `write` unchecked by default · C: `write` → My tasks only | **A**, never Full (Beacon agreed). The family respects `TASK_API_ENABLED` (`TaskApiSettings`) and `BillingAccount::$taskApiAllowed` like `bt_` tokens; a future "allow desktop app" is a second boolean next to it, no new policy (§3.1) |
| **Q-BD-24** **[Beacon]** ✔ agreed | Is the desktop channel `app` a person for *humans only* columns and Beacon's transition policies? | A: yes (not in `MACHINE_CHANNELS`) · B: no, like `api` | **A** (Beacon agreed): a device-code-authenticated person is behind it; `humans_only` columns already exist (MCP `BoardGetTool` exposes the flag); MCP and bots stay non-human; writes audited as channel `app` |
| **Q-BD-25** | tokens/1 for tasks | A: TaskBoard's own converter, one shared spec + fixtures with ChatKit · B: extract a shared package first | **A**; dedup candidate |
| **Q-BD-26** **[Beacon]** ✔ agreed | Images in descriptions and comments | A: neutral card in BD-3, signed short-lived URL after the access check in BD-4 · B: never in the app | **A** |
| **Q-BD-27** **[Beacon]** ✔ agreed | Realtime for tasks | A: ids-only change port in TaskBoard 3.5.0, batched async Beacon fan-out to per-user private topics (the channel of `MemberIssueRealtimeNotifierInterface`) · B: polling only | **A** with polling as fallback (from 3.4.0). Web live board refresh does not exist in Beacon today; using the port for it is new Beacon work (B-T11) |
| **Q-BD-28** | One SSE stream for chat and tasks, or one per module? | A: one per family · B: one combined JWT | **A** (keeps family isolation, R3) |
| **Q-BD-29** | `If-Match` on desktop writes | A: required (`428` without) · B: optional as the Task API | **A** for v1 (a first-party client always has the revision) |
| **Q-BD-30** | Create task from a chat message | A: source link verified by Beacon, no automatic chat reply · B: plus an automatic reply · C: reply as a per-user setting, off by default | **C** (A from BD-4, the setting once chat send ships) |
| **Q-BD-31** ✔ agreed by Beacon | TaskBoard version order (§11) | A: CU-2 3.2.0, CU-3 3.3.0, client API 3.4.0 and 3.5.0, ClickUp phase 2a → 3.6.0 · B: client API first (3.2.0), ClickUp shifted by two | **A** (Beacon's request first, the ClickUp design's numbers stay; the client API branch can be built in parallel and tagged after CU-3) |
| **Q-BD-32** | Task notifications on the desktop (assigned to me, mentioned, a question waiting for me, due today) | A: from Beacon's own notifications (the bundle keeps no feed, decided 2026-11-18), opt-in, BD-4 · B: none, badge only | **A**, preview level *None* by default |
| **Q-BD-33** | What is "My tasks"? | A: assignee, plus a *To review* bucket for reviewer · B: assignee only · C: also watcher | **A** |
| **Q-BD-34** | Due buckets' "today" | A: the client's local date (`today=`), checked ±1 day · B: the person's Beacon timezone | **A** (works while travelling; no profile read) |
| **Q-BD-35** **[Beacon]** ✔ agreed | Connected apps page with a third family | A: one row per device, badges Time / Chat / Tasks, each revocable (Q-BD-19 extended) · B: one row per token | **A** |
| **Q-BD-36** | Kanban paging | A: per column, 30 cards, cursor · B: whole board in one call (bounded) | **A** (large boards stay fast) |
| **Q-BD-37** | Delete tasks from the desktop | A: archive only · B: delete as the Task API (needs the board's manage decision) | **A** |

## 11. Phases and versions

TaskBoard's ClickUp line is already planned (`docs/design/CLICKUP_IMPORT.md`): **CU-1 3.1.0 built**, **CU-2 3.2.0** (import
plans + wizard), **CU-3 3.3.0** (native fields), phase 2a 3.4.0 (scheduled incremental). With Q-BD-31 A, the client API
takes **3.4.0** and **3.5.0**, and ClickUp phase 2a moves to **3.6.0** (no ClickUp decision changes). The client API is a
separate area (`src/ClientApi/**`), so it can be built in parallel with CU-2 and rebased; it is tagged after CU-3.

Security audits (REQ-SEC-004): **immediate** for anything that touches tokens, authentication or permission filtering;
batched otherwise (owner rules 2026-11-07 / 2026-11-13). Every touched bundle closes all its REQ gaps before its tag
(owner rule 2026-11-24).

| Phase | App | TaskBoardBundle | TimeTrackBundle | ChatKitBundle | Beacon | Audit |
|---|---|---|---|---|---|---|
| **BD-2** (0.10.0, chat read-only) | Shell with a hidden Tasks module (`features.tasks` from Beacon) | — (CU-2 3.2.0 in progress) | 2.2.0 (families; nothing extra for tasks) | 2.4.0 | Nothing for tasks: Beacon builds the chat row first; the `tasks` row comes after BD-2 (Beacon, 2026-11-25) | as the main design |
| **BD-3** (0.11.0, chat send + **tasks core**) | Landing module rule (§9); connect tasks (device flow, `tasks-token`), My tasks, boards, kanban + list, task detail (read), quick create, edit fields, move with `If-Match`, checklists, start timer (time API), polling via `changes` | **3.4.0** (minor, after CU-3 3.3.0): `client_api` config (off by default), `/task-board/v1` read + core write routes (§4.2, §4.3 without questions-write, comments-write, parent, subtasks-create), ports (principal, context, reference, link visibility, file, source), bundle authenticator, tokens/1 converter, `ColumnTransitionVia::APP`, my-tasks query + indexes, `changes`, OpenAPI v1, `docs/CLIENT-API.md`, worker test | — | — (send etc. in 2.5.0 as planned) | Register the `tasks` family (respecting `TASK_API_ENABLED` and `task_api_allowed`); resolver + context policy adapter (`tasks`); firewall; provenance `app`; link visibility for issues; reference resolver; audit; idempotency `forget()` on revoke and on erasure; connected-apps badges; rate limits | **Immediate**: TaskBoard 3.4.0 (new authenticated API, R2 filtering), Beacon adapter + approval page. App: immediate review of the third token and its storage |
| **BD-4** (1.0.0) | Realtime (SSE, second stream), comments read/write with images, questions (answer, ask), subtasks tree editing, members, create task from chat message, task notifications (opt-in), keyboard drag and drop polish | **3.5.0**: `TaskBoardChangePublisherInterface` (ids only, after commit), `GET realtime`, comments write, questions, parent, subtasks, `files/{id}`, `source` for `chat_message`; the port also makes the roadmap's web live board refresh possible | — | — | `BeaconTaskRealtime` (topic, JWT), batched async fan-out (channel of `MemberIssueRealtimeNotifierInterface`), optional new web live board refresh, file resolver (signed URL), source link for chat messages, task notification previews | **Immediate** for 3.5.0's realtime fan-out and file URLs (data exposure); batched for the rest; full audit before app 1.0.0 |
| after 1.0 | Offline cache (encrypted), saved views, activity tab | 3.6.0 = ClickUp phase 2a; later client API minors as the roadmap lands (saved views, WIP limits, labels) | — | — | — | batched |

Ordering with Beacon: Beacon's own requests first (owner priority, ClickUp CU-2/CU-3 included), then the client API.
Beacon agreed (2026-11-25): TaskBoard CU-2 (3.2.0) → CU-3 (3.3.0) → client API 3.4.0 → 3.5.0; in Beacon the `tasks` row
comes after BD-2 (chat).

## 12. Beacon work, item by item

| # | Item | Phase |
|---|---|---|
| B-T1 | **`tasks` scope family**: a `DeviceScopeFamilyProviderInterface` service returning `DeviceScopeFamily('tasks', 'Tasks', ['task-board:read' => …, 'task-board:write' => …])` (en / es labels), respecting the instance switch `TASK_API_ENABLED` (`TaskApiSettings`) and the organisation switch `BillingAccount::$taskApiAllowed` (Q-BD-23); built after BD-2 (chat) | BD-3 |
| B-T2 | **Resolver row for `tasks`**: the generic family adapter (the one written for chat) gets a `tasks` entry: `ClientFamilyTokenAuthenticator::authenticate('tasks', …)` → `TaskClientPrincipal {user, scopes, tokenId (session id), tokenName ("Beacon Desktop · <device>"), contextKey}`; configured as `nowo_task_board.client_api.principal_resolver` | BD-3 |
| B-T3 | **Context policy**: TimeTrack's `ClientContextPolicyInterface` answers for family `tasks` as for `chat` (Personal + organisations the person belongs to); TaskBoard's `whereFor()` maps `personal` → the personal tenant key, `org:<uuid>` → the organisation's tenant keys and its projects' keys (as `TaskApiOrganizations` does today), minus organisations with `task_api_allowed = false` (also left out of `contextsFor()`; Q-BD-23) | BD-3 |
| B-T4 | **Firewall** `task_board_client_api` on `^%nowo_task_board.client_api.v1_path_prefix%/`, stateless, `custom_authenticators: [nowo_task_board.client_api.authenticator]`, no `access_control` on the path; route import `nowo_task_board_client_api` | BD-3 |
| B-T5 | **Provenance**: `write_provenance_provider` maps the v1 path to channel `app` and the device label; transition policies (`WIP_LIMIT` and others) treat `app` as a person (Q-BD-24) | BD-3 |
| B-T6 | **Audit**: `ClientApiAuditSubscriber` logs `family: tasks`; the existing `API_WRITE` listener records `channel: app`; refusals from `TaskClientApiDeniedEvent` | BD-3 |
| B-T7 | **R2 ports**: `TaskObjectLinkVisibilityInterface` for issues, chat messages, wiki pages, monitors; `TaskClientReferenceResolverInterface` reusing the chat reference rules | BD-3 |
| B-T8 | **Revocation and erasure**: revoking a `tasks` token (account page, sign-out) **and erasing the user** (Beacon's GDPR eraser, for every `tasks` token the user had) call TaskBoard's `TaskApiIdempotencyStoreInterface::forget(sha256('nowo-task-board-api|' . $tokenId))` | BD-3 |
| B-T9 | **Connected apps page** (Account → Security, today "Time tracking apps"): one row per device with **Time / Chat / Tasks** badges, each revocable on its own; approval page shows the family "Tasks" with its two scopes, deny focused; sign-in notification names the family | BD-3 |
| B-T10 | **Rate limits**: per-token budget 120/min for `tasks`; `TaskApiRateLimiterInterface` budgets for writes, creates, comments, search, shared with personal tokens; cache pool in Redis | BD-3 |
| B-T11 | **Realtime**: `BeaconTaskRealtime` over `ConfiguredMercure` (topic `/nowo-task-board/users/<publicId>`, 15-minute subscribe-only JWT); `TaskBoardChangePublisherInterface` implementation with batched, async, per-reader fan-out (ids only, after commit) through the channel `TaskNotificationListener` already uses (`MemberIssueRealtimeNotifierInterface`). **New** (optional, can follow the desktop): web live board refresh subscribing to the same hints — Beacon has none today | BD-4 |
| B-T12 | **Files**: `TaskClientFileResolverInterface` → access check, then a short-lived signed GET URL from the storage profile (R6 style: the client never sees credentials) | BD-4 |
| B-T13 | **Create from chat**: `TaskClientSourceLinkInterface` checks that the person can read the message now and returns the `chat_message:<uuid>` host-object link | BD-4 |
| B-T14 | **Task notifications** for the desktop from Beacon's notification stream (assigned, mentioned, question waiting, due today), preview endpoint with the organisation cap (Q-BD-9, Q-BD-32) | BD-4 |
| B-T15 | **Manual** (en, es): "Beacon Desktop → Tasks", connecting, what the scopes allow, revoking | BD-3 |

## 13. Out of scope

- Board, column, column-set, folder and template management; custom fields; dependencies and links editing; attachment
  uploads; bulk edit; deleting tasks (archive only) — they stay in the web app.
- Time entries through the tasks API (the TimeTrack client API owns time).
- Gantt, calendar, workload and dashboards in the desktop.
- Multi-user cursors (owner, 2026-11-18).
- Any change to `/api/tasks/v2`, its ClickUp contract or personal tokens.
