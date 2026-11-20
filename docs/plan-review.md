# Review: Badminton Tournament Management System – Technical Development Plan

Reviewed: 2026-11-15

## Verdict

The plan is solid on architecture: one laptop server, the database as the only source of truth, scoring checked on the server, version numbers on matches, and idempotent commands. Those are the right calls. Its main weaknesses:

1. **It is far too big for a first release.** It has no phases, so nothing can be shipped early.
2. **Several core concepts are undefined.** The match status flow, the rule for "one active umpire per match", how corrections spread to later bracket matches, and how retries interact with versions are all missing. These are the parts most likely to cause bugs during a live tournament.
3. **The data model has gaps and duplication.** Singles is not supported, there is no `users` collection, and `assignments`/`schedules` duplicate data already on `matches`.
4. **Some requirements conflict.** "Secure cookies", "no CDN" and "keep the phone screen on" all depend on choices the plan leaves open, mainly whether to use HTTPS.

Findings are ordered by impact.

---

## 1. Blocking issues (decide before writing code)

### 1.1 Singles is not supported: model entries, not pairs
Every part of the plan says "pair": match fields, standings, the API, the `pairs` collection. Most club tournaments include MS and WS events. If two-player pairs are built into the model, singles will later be hacked in as a "pair with one player".

**Fix:** Replace `pairs` with an `entries` collection (`categoryId`, `players: [1..2]`, `seed`, `status`), where the category's `discipline` (singles/doubles) sets the required player count. Matches, standings and brackets then reference `entryId`s.

### 1.2 No `users` collection
Section 4 defines Super Admin and Tournament Admin roles, but section 13 only has `umpires`. Admin accounts have nowhere to live.

**Fix:** Use one `users` collection with `role` (`super_admin | tournament_admin | umpire`), `passwordHash` or `pinHash`, `active`, and optional `tournamentIds` to limit scope. Spectators stay anonymous.

### 1.3 Two copies of the same data: `assignments` and `schedules` vs `matches`
`matches` already has `courtId`, `umpireId` and a sequence. A separate `assignments` collection and `schedules` collection create three places where "which court is match 14 on" is stored, and they will drift apart.

**Fix:** Keep court, umpire, `queuePosition` and `scheduledAt` on the match document. Drop `assignments` and `schedules`, or keep `schedules` only as generation metadata (generator parameters and run timestamp). History of reassignments belongs in `auditLogs`.

### 1.4 The match status flow is undefined
The plan lists 8 statuses but never says which changes between them are allowed, who may make each change, or what "Awaiting Confirmation" means in practice.

**Fix:** Write the transition table and enforce it in one domain function. For example:

| From | To | Who | Trigger |
|---|---|---|---|
| Pending | Scheduled | admin | court/queue assigned |
| Scheduled | Ready | system | both entries known and free, court free |
| Ready | In Progress | assigned umpire | start |
| In Progress | Paused / In Progress | umpire, admin | pause/resume |
| In Progress | Awaiting Confirmation | system | final rally detected |
| Awaiting Confirmation | In Progress | umpire | undo the final rally |
| Awaiting Confirmation | Completed | umpire (submit) or admin (approve) | **decide which one** |
| any non-final | Walkover / Cancelled | admin | — |
| Completed | Completed (corrected) | admin | correction with audit entry |

Also add **Retired** (injury during the match) as either its own status or a result type. It is common in badminton and differs from a walkover: the games already played count in standings.

### 1.5 Retries and version checks conflict
The plan requires both "reject stale commands (version check)" and "duplicate requests must not add points twice". These collide when a retry happens. If the umpire's phone sends point #37 (actionId X, expectedVersion 36), the server applies it, and the response is lost, the retry still carries expectedVersion 36. The version check rejects it as stale, the client shows an error, and the umpire may tap again and add a real duplicate point.

**Fix:** Check in this order:
1. If `actionId` is already in the match's action log, return **200 with the current state** (already applied). Do not return an error.
2. Otherwise, if `expectedVersion != version`, return **409 with the current state**. The client must not retry automatically.
3. Otherwise, apply the action with one conditional update:
   `findOneAndUpdate({_id, version: v, status: 'in_progress', 'actions.actionId': {$ne: X}}, {$push: {actions: …}, $set: {score…}, $inc: {version: 1}})`.

All of this stays inside one document, so **the scoring hot path needs no transactions**.

### 1.6 "One active umpire controller" has no rule for changing hands
Phones die, browsers get closed, and umpires swap mid-match. Without a defined handover, a match either gets stuck or ends up with two controllers.

**Fix:** Store `controller: {userId, sessionId, claimedAt, lastSeenAt}` on the match. Only that session may score. Allow takeover when (a) the same user reconnects from a new session (automatic), or (b) an admin reassigns the match (explicit, audited). Do not let a disconnect alone release control. The version check already protects against brief overlaps.

### 1.7 Corrections and knockout advancement
If an admin corrects a quarterfinal after the winner has already played the semifinal, the plan does not say what happens.

**Fix:** Allow a correction that changes the winner only when the downstream match is still Pending, Scheduled or Ready. In that case, swap the advanced entry in the same transaction. If the downstream match has started, block the correction with a clear message. A cascading reset can be added later as a separate, explicit operation.

---

## 2. Badminton rules the scoring config does not cover

"Scoring driven by configuration" is the right idea, but the listed options (target, margin, cap, side switch) do not cover real rally scoring:

- **Deuce and cap are linked:** 21 points, win by 2, capped at 30 (at 29-all the next point wins). Model this as `{pointsToWin, winBy, cap}`. The engine must stop requiring "win by 2" once the cap is reached.
- **Mid-game interval and side change:** interval at 11 (or at half of `pointsToWin`), and a side change at 11 in the deciding game. The scoring UI should show prompts for these.
- **Serving and service courts:** for doubles, the server and receiver follow from score parity plus who won the rally. If serve tracking is in scope, the engine must store the serving order for each game, not just "the serving side". Keep serve tracking optional, but design for it from the start, because adding it later means rewriting stored match state.
- **Game count:** `gamesToWin` (1 or 2), not a fixed "best of 3".
- **Undo across a game boundary:** undoing the rally that ended a game must reopen that game. This is simple if game state is derived from the action log and painful if games are stored as separate mutable records.

**Recommendation:** Make the scoring engine a **pure function** in `packages/shared`: `(config, actions[]) → MatchState`. The server stores actions plus a cached state, undo removes the last action and recomputes, and the same function runs in the browser to show score previews. Test this one module very thoroughly. It is the most important code in the system.

---

## 3. Scope: phase it

As written, version 1 includes team competitions, CSV/Excel import, drag-and-drop scheduling, an automatic scheduler with rest intervals, backup/restore, and four test layers. That is several months of work before one real match can be scored.

Suggested phases:

| Phase | Scope | Exit criterion |
|---|---|---|
| **1 – Score a match** | Auth (admin + umpire PIN), tournament/category/entry CRUD, manual match creation, court assignment, umpire scoring with sockets, live scoreboard, spectator view | 4 phones score 4 courts at the same time with no lost or duplicate points |
| **2 – Run a round robin** | RR generation, court queue, standings + tiebreakers, results correction + audit, backup/restore | Run a full club RR event end to end |
| **3 – Knockout** | Bracket generation with seeding and byes, group→KO qualification, auto-advance, 3rd place | Group stage + KO event end to end |
| **4 – Ops polish** | CSV import, drag-and-drop schedule, conflict suggestions, reports, TV display mode | — |
| **5 – Teams** | Team ties, captains, team standings | — |

Team competitions also need an extra concept the plan skips: a **tie** (team A vs team B) made up of several **rubbers** (individual matches). Leave this out of the core data model until phase 5, but keep `matches.tieId` as an optional field.

---

## 4. Scheduling: use a court queue, not a timetable

Fixed-time scheduling across courts with rest constraints is a hard optimization problem, and real badminton events rarely keep to fixed times anyway. Most run as "**next match goes to the next free court**."

**Recommendation:** For phases 1–3, keep a global ordered queue of Ready matches. When a court frees up, offer the first queued match whose entries are not playing and have rested `minRestMinutes` since their last match ended. Admins can reorder the queue or pin a match to a court. This covers most of the scheduling rules in section 10 with a simple greedy check, and drag-and-drop becomes "reorder the queue".

---

## 5. Standings and brackets: unstated details

- **Tiebreakers with 3 or more tied entries:** head-to-head only works for two-way ties. Specify the full order. BWF style is: match wins, then head-to-head if exactly two are tied, then for 3 or more: game difference, then point difference, then recalculate head-to-head among those still tied. The plan's "Ranking Configuration" should be an ordered list of these rules.
- **Walkovers and retirements in standings:** decide whether a walkover counts as 2–0 / 42–0, or counts as a win with no games or points credited.
- **Byes and seeding:** draw sizes that are not a power of two need byes for the top seeds. Seeds 1 and 2 go in opposite halves. Pairs from the same group (or same club) should be kept apart in round 1.
- **Group → knockout mapping:** e.g. 1A vs 2B, 1B vs 2A. Make the mapping configurable per category.

---

## 6. Security and networking: requirements that conflict

- **HTTPS decides several other requirements.** Secure cookies need HTTPS. The **Screen Wake Lock API** (stops umpire phones from sleeping mid-match) needs a secure context, and so do **service workers / PWA**. A local self-signed certificate shows a warning on every phone, and installing a local certificate authority on iOS takes several manual steps.
  **Recommendation:** Use plain HTTP for v1. Use HTTP-only `SameSite=Strict` cookies (without the `Secure` flag), short umpire sessions, and PIN lockout. Document that someone on the same Wi-Fi could read traffic. For the screen-sleep problem, use a fallback such as the NoSleep-style hidden video trick, or tell umpires to set auto-lock to "Never". Revisit HTTPS if the Wi-Fi isn't controlled by the organisers.
- **CORS:** everything runs on one origin, so **do not enable CORS at all**. "Restrict CORS to trusted origins" adds config with no benefit.
- **PINs:** a 4-digit PIN has 10,000 possibilities. Add lockout per user *and* per IP address (e.g. 5 failures → 5 min). Hash PINs with argon2 or bcrypt like passwords. Prefer 6 digits.
- **Socket.IO auth:** authenticate during the connection handshake using the same session cookie. Spectators connect anonymously and may only join `tournament:*`, `court:*` or `match:*` rooms for **reading**. All writes go through REST.
- **Offline assets:** Angular Material's default setup loads **Material Icons and Roboto from Google Fonts**. These must be self-hosted (e.g. `@fontsource/roboto`, `material-symbols` npm packages), or the UI breaks without internet. Add an "airplane mode" check to CI with Playwright (block all non-localhost requests).

---

## 7. MongoDB on Windows: practical notes

- **Replica set:** transactions (needed for corrections, KO advancement and bracket generation) require a replica set. Configure a **single-node replica set** from day one (`replication.replSetName` in `mongod.cfg` + `rs.initiate()`). Adding it later on a laptop that's already in use is the kind of step that gets forgotten before the event.
- **Backups:** `mongodump`/`mongorestore` come in the separate **MongoDB Database Tools** package on Windows. Include it in the setup checklist. Run automatic backups to a second disk or USB drive (every N minutes during an event, plus on every result submission if that is cheap).
- **Bind to localhost:** `bindIp: 127.0.0.1` is correct and enough. Also make sure the Windows firewall rule only opens the app port.

---

## 8. Real-time sync: refinements

- Include `version` in every `score:updated` broadcast. Clients ignore any update with a version ≤ the one they hold. This handles events arriving out of order and the refetch-vs-broadcast race after reconnecting.
- On reconnect: rejoin rooms first, **then** refetch state, so no update falls into the gap between the two.
- `court:{courtId}` and `match:{matchId}` rooms overlap. A court scoreboard can subscribe to the court room only and receive whichever match is on that court. Keep `match:*` for the umpire and admin detail views.
- Settle on **REST commands + socket broadcasts** (the plan lists both REST scoring endpoints and socket events but never says which one carries commands). REST gives you validation middleware, idempotency and Supertest coverage for free. On a LAN the extra latency is under 50 ms.

---

## 9. Laptop and venue operations (missing from section 18)

- Set the Windows **network profile to Private**, or firewall rules and LAN discovery won't work.
- Turn off **sleep and hibernate** on the power plan, and turn off Windows Update automatic restarts during event days.
- Router: turn off AP/client isolation (already noted), reserve the IP, and prefer 5 GHz for phones. Test the busiest moment, when many spectators connect at once.
- Run the app as a **Windows service** (e.g. NSSM or `node-windows`) so it restarts after a crash or reboot without someone typing commands.
- Show the connection QR code on the admin dashboard, not just in the console.

---

## 10. Smaller gaps

- **Monorepo tooling is not chosen.** npm workspaces vs Nx. With Angular CLI + Express + a shared TS package, **npm workspaces** with TS project references is enough. Nx adds value only if build caching becomes a problem.
- **Time source:** use server time for all `startedAt`/`completedAt` values. Never trust phone clocks.
- **Category eligibility:** "validate player eligibility" needs fields that don't exist yet: gender, birth date or age group, and skill grade on `players`, plus eligibility rules on `categories`.
- **Unmeasurable acceptance criteria:** add numbers. For example, a score shows on all clients within 1 s at p95 with 4 umpires + 100 spectators; full state is restored within 5 s of reconnecting; zero lost or duplicate points in a 4-court × 2-hour soak test with random network drops.
- **Audit scope:** section 13 audits "administrative actions"; scoring actions are already in the match action log. Say explicitly that the action log *is* the scoring audit, so they don't get logged twice.
- **Deleting tournaments:** use archive or soft delete for anything that has results. Allow hard delete only for tournaments that are still in draft.

---

## Suggested next steps

1. Settle the decisions in section 1 (entries, users, match status flow, retry/version order, controller handover, correction rule).
2. Write the shared scoring engine with exhaustive unit tests (deuce, cap, game boundaries, undo across games, serve tracking).
3. Build phase 1 and test it with 4 real phones on the actual router before adding anything else.
