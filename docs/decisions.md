# Design Decisions

Decisions made after [plan-review.md](plan-review.md). These override the original technical plan where the two disagree.

Last updated: 2026-11-15

---

## D1. Competitors are "entries" (doubles first, singles allowed)

Doubles is the only format the UI needs for now. The data model still uses a generic **entry** rather than a fixed **pair**, because the cost is almost nothing and it avoids a migration later.

```
entries
  _id
  tournamentId
  categoryId
  playerIds: [ObjectId]      // length must match category.playersPerEntry
  displayName                // e.g. "Santos / Reyes", generated, editable
  seed?: number
  status: active | withdrawn
```

- `categories.discipline`: `doubles` (default) or `singles`. This sets `playersPerEntry` to 2 or 1.
- Matches, standings and brackets reference `entryAId` / `entryBId`, never player IDs directly.
- Phase 1 UI only exposes doubles. Enabling singles later is a UI change, not a schema change.
- Serve tracking (if enabled later) must handle 1 or 2 players per side. Keep it optional.

## D2. Accounts: admins only. No umpire accounts.

There is **no `umpires` collection**. Umpires do not get accounts.

```
users
  _id
  username
  passwordHash               // argon2id
  role: super_admin | tournament_admin
  active
```

### How umpires get access

Umpire access is per court, not per person:

1. An admin opens **Courts** and generates a **court access code** for each court (6 digits, hashed, can be regenerated at any time). The admin dashboard shows a QR code per court that contains the URL `/umpire?court=<courtId>`.
2. The umpire scans the court's QR code, enters the code and **types their name**. The server creates an umpire session: an HTTP-only cookie tied to `{courtId, umpireName, sessionId}`, which expires at the end of the tournament day.
3. The umpire sees the match currently assigned to that court and can start or score it. They cannot touch any other court.
4. When the match starts, the name is stored on the match: `match.umpire = {name, sessionId, claimedAt}`. Results and reports show who officiated.

Why a per-court code and not just a name: anyone on the venue Wi-Fi can open `/umpire`. A name alone would let any spectator score any match. The code is the access check, and the name is only a label for the record.

Rules:
- Lockout: 5 wrong codes from one IP address → 5-minute block for that court.
- Regenerating a court code ends all sessions on that court immediately (useful if a code leaks).
- Admins can always score or correct any match from the admin UI.

## D3. Court, umpire and queue are stored only on the match

`assignments` and `schedules` collections are **dropped**.

```
matches (relevant fields)
  courtId?: ObjectId
  queuePosition?: number     // global order of upcoming matches
  umpire?: { name, sessionId, claimedAt, lastSeenAt }
```

- Reassignments are written to `auditLogs`.
- Settings for generating draws (rest interval, etc.) live on the category or tournament document.

## D4. Match status flow

Statuses: `pending`, `scheduled`, `ready`, `in_progress`, `paused`, `awaiting_confirmation`, `completed`, `walkover`, `retired`, `cancelled`.

| From | To | Who | Trigger |
|---|---|---|---|
| pending | scheduled | admin | placed in queue / on a court |
| scheduled | ready | system | both entries known, neither playing, court free |
| ready | in_progress | court umpire / admin | start |
| in_progress | paused | court umpire / admin | pause |
| paused | in_progress | court umpire / admin | resume |
| in_progress | awaiting_confirmation | system | final rally recorded |
| awaiting_confirmation | in_progress | court umpire | undo the final rally |
| awaiting_confirmation | completed | court umpire | **submit** (the umpire's submit makes the result official) |
| in_progress / paused | retired | court umpire / admin | one side retires; games already played still count |
| pending / scheduled / ready | walkover | admin | one side does not show |
| any non-final | cancelled | admin | — |
| completed / retired / walkover | same status, corrected | admin | correction (see D7) |

- Final statuses: `completed`, `walkover`, `retired`, `cancelled`.
- An umpire's submit is final. Admins fix mistakes with corrections, not an approval step. This keeps courts moving.
- All transitions go through one domain function, `transitionMatch(match, action, actor)`. Controllers and socket handlers never set `status` directly.

## D5. Order of checks for scoring commands

For every command (`point`, `undo`, `start`, `submit`, …) carrying `{actionId, expectedVersion}`:

1. `actionId` is already in `match.actions` → **200 + current state**. Duplicate retry, nothing changes.
2. `expectedVersion !== match.version` → **409 + current state**. The client shows the refreshed score and does not retry automatically.
3. The status or rules forbid the command → **422 + reason**.
4. Otherwise, apply it with a single conditional update:
   ```
   findOneAndUpdate(
     { _id, version: expectedVersion, 'actions.actionId': { $ne: actionId } },
     { $push: { actions: action }, $set: { state: newState }, $inc: { version: 1 } }
   )
   ```
   If nothing matches (a race between the checks and the update), reload and restart from step 1.

The client generates `actionId` (UUID v4) **once per button tap** and reuses it on every retry of that tap.

## D6. One umpire controls a match at a time

- `match.umpire.sessionId` is the only session allowed to score.
- The same court session reconnecting (refresh, Wi-Fi drop) → control continues automatically.
- A **different** umpire session on the same court (phone died, umpires swapped) → shows "Take over this match from <name>?". After confirmation, control moves to the new session, an audit entry is written, and the old session becomes read-only.
- A disconnect alone never releases control.
- Admins can always take over.

## D7. Corrections and the bracket

- Correcting the score **without changing the winner** is always allowed. Standings are recalculated and broadcast.
- Correcting a result **that changes the winner**:
  - Allowed if the downstream match is `pending`, `scheduled` or `ready`. The winner placed in the next round is swapped in the same transaction.
  - **Blocked** if the downstream match is `in_progress` or final, with a message naming that match. Cascading resets are out of scope for now.
- Every correction writes an `auditLogs` entry `{actor, matchId, before, after, reason}`. A reason is required.
- Corrections, knockout advancement and bracket generation use MongoDB transactions, so set MongoDB up as a single-node replica set from day one.

---

## D8. No per-level categories: a pair's level is its position in its team's list (2026-11-16)

Supersedes the "one category per level (MD-A ... MD-J)" idea in [scheduling-plan.md](scheduling-plan.md) §1.

- Categories are **divisions** only (Men's Doubles, Women's Doubles); a division holds the scoring rules.
- Each team lists its pairs in order. The order is the pair's `rank` (1 = first). The label `MD-A` is derived from it (division code + letter of the rank); it is never stored or entered.
- Team A meets Team B once per rank: A's pair #k plays B's pair #k. Teams with fewer pairs only play the positions both have, and the gap is reported.
- A lineup paste is `Team | Division | Player 1 | Player 2`; row order within a team and division sets the ranks. An old-style `MD-C` is read as `MD`.
- Reordering a team's pairs (arrows on the lineup grid) only changes which pairs *will* meet; matches already generated keep their pairs until regenerated with Replace.
- The scheduler keeps "MD-A" together on one court as a soft preference by grouping on division + rank.

## D9. Manual schedule edits (slice C)

- A move or swap is decided by the server (`PATCH /api/matches/:id/schedule`), never by the client. Hard rules block (player overlap, court double-booked, court closed, after end of play, occupied cell without swap); soft rules (minimum rest) need `confirmWarnings`.
- Only pending, scheduled and ready matches move, and only when not locked. Called, live and finished matches stay put; the scheduler treats called matches as fixed.
- Writes are guarded by the match version. A swap parks the dragged match first so two matches never share a cell, and a final check rolls the change back if someone else took the same cell at the same moment.
- A match is "called" (`POST /api/matches/:id/call`) before the umpire starts it; one called or live match per court.
