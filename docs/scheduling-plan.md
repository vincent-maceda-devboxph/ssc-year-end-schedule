# Match Generation & Scheduling: Integration Plan

This plan combines the "Automatic Match Generation and Scheduling Module" spec with what you told me in chat (4 teams, men's and women's doubles, team round robin, 1 point per win) and with the phase 1 code that already exists.

Last updated: 2026-11-15

---

## 1. How your format maps onto the spec

The spec treats **levels as categories** (MD-A, MD-B, MD-C, WD-A, …). Your "pair #1 vs pair #1, #2 vs #2" becomes "each level is a category, and every team puts pairs into it".

| You said | In the system |
|---|---|
| 4 teams (or however many are set) | `teams` collection, one record per team (name, colour, captain) |
| 10 men's doubles pairs per team | 10 categories **MD-A … MD-J**, one pair per team in each. Or fewer levels with several pairs per team (see below). |
| 6 women's doubles pairs per team | 6 categories **WD-A … WD-F** |
| Pair 1 vs 1, 2 vs 2 | Inside a category, pairs from **different** teams play each other once |
| Win = 1 point for the team | Team standings: 1 point per match won |

With one pair per team per category: 16 categories × 6 matches (4 teams round robin) = **96 matches**. That's the same as your description.

The same rule also covers the spec's extra cases without special code:
- **Several pairs from one team in a category** (e.g. MD-A has 2 pairs per team): each pair plays every pair from the other teams. Same-team matchups are **skipped by default**, with a per-category setting to allow them.
- **Unequal team sizes, or an odd number of pairs:** it is still a plain round robin, with no byes needed.

## 2. ⚠ Time check: 96 matches is a long day

| Courts | Match length | Rounds needed | Duration from start |
|---|---|---|---|
| 4 | 30 min | 24 | **12 h** (3 PM → 3 AM) |
| 6 | 30 min | 16 | 8 h |
| 4 | 20 min (single game to 21) | 24 | 8 h |
| 8 | 20 min | 12 | 4 h |

This is before rest rules and players who play in two categories, both of which add time. The scheduler will always show the estimated finish time and warn if it is past the tournament's end time. The format itself still needs a decision; see open question Q1.

## 3. What already exists vs. what gets added

Following the spec's rule to "reuse, don't duplicate":

| Spec item | Already in phase 1 | Change |
|---|---|---|
| tournaments | yes | **Add** schedule settings: `startAt`, `endAt?`, `timezone`, `matchMinutes`, `minRestSlots`, `preventConsecutive`, `seed` |
| teams | — | **New** collection: `name`, `color`, `captainPlayerId?`, `status` |
| players | yes | **Add** `teamId` |
| pairings | `entries` (same thing) | **Add** `teamId`. Expose `/api/tournaments/:id/pairings` as an alias, with no second collection. |
| categories | yes | **Add** `code` (MD-A), `format` (`team_round_robin` \| `round_robin`), `priority`, `allowSameTeam` |
| courts | yes | **Add** `status` (available / unavailable) and optional `availableFrom`/`availableUntil` |
| matches | yes | **Add** `team1Id`, `team2Id`, `plannedStart`, `plannedEnd`, `isLocked`, `scheduleVersion`, `generatedBy` |
| schedules | — | **New:** one document per saved or published version (settings used, assignments, diff from the previous version, who and when) |
| scores | embedded in `matches` (action log + score) | Keep it there. A separate collection would duplicate the source of truth. |
| standings | — | **Computed** from matches on request and pushed via socket. No stored copy that could go stale. |
| Match status "Called" | — | **Add** `called` between `scheduled` and `in_progress`. "Ongoing" is the existing `in_progress`. |

Times are stored in UTC, with the tournament's `timezone` (default `Asia/Manila`) used for display.

## 4. Match generator (independent from scheduling)

`POST /api/tournaments/:id/matches/generate { categoryIds?, replace? }`

- Reads the active pairs in each selected category and builds a round robin among pairs from different teams (or all pairs if the category is not a team category).
- Validates the input before generating:
  - every pair has 2 active, distinct players, both registered to the pair's team;
  - no player is in two pairs within the same category;
  - no duplicate matchups.
- If matches were already generated for a category, it refuses unless `replace` is set. Even with `replace`, only matches that **have not started** are deleted; recorded results are never touched.
- Returns `{created, skipped, problems[]}`.
- Single elimination and group stage plug into the same service later; see section 9.

## 5. Schedule engine

**Inputs:** tournament settings, active courts and their availability windows, all matches that are not final, and locked matches.

**Time slots:** `startAt + k × matchMinutes`, for each court, until `endAt` (or open-ended).

### Hard constraints (never violated)
1. A player is in at most one match per slot. This is checked by **player ID**, so a player in MD-A and in a mixed pair is caught.
2. A court hosts one match per slot, and only while it is available.
3. Locked, ongoing and completed matches stay exactly where they are.
4. A pair's matches are at least `minRestSlots` apart. This is configurable and **can be set to 0** if you treat rest as a preference only.

### Soft constraints (scored, relaxed when needed)
- Longer rest for each player
- No consecutive matches
- No more than N matches of the same team at the same time
- Categories spread across courts
- Fair waiting times between teams
- Category priority (earlier slots)
- Few empty court slots
- Earliest overall finish

### Algorithm
1. Order matches **most-constrained first**: matches whose players have the most matches go first, then by category priority.
2. **Greedy placement:** for each match, take every valid (slot, court) pair and score it with the soft rules. Place the best one; ties are broken by the seeded random generator (same seed = same schedule, a new seed = a variation).
3. **Repair/backtrack:** if a match has no valid place, try moving up to *k* already-placed (unlocked) matches that block it. If that still fails, add more slots (only when there is no `endAt`) or report the match as unschedulable.
4. **Local improvement pass:** swap pairs of matches when the swap improves the score without breaking any hard rule.
5. **Output:** assignments, estimated finish, per-player rest statistics, and `unscheduled[]` with plain reasons (e.g. "MD-C Ken/JL vs Baitan/Paul: Ken is busy in every remaining slot before 9:00 PM").

A schedule that breaks a hard rule is never returned. The final output is re-checked by an independent validator before anything is saved.

### Flow
**Preview** (computed, not saved) → **Save** (draft version, umpires don't see it) → **Publish** (applied to matches, version + 1, broadcast). **Regenerate remaining** uses the same engine but only for matches that are not locked and have not started. It prefers to keep matches in their published slot when that is still valid, and shows a diff before publishing.

## 6. Admin UI: Schedule page

- **Settings panel:** start time, match minutes, rest, courts, seed, preferences. Buttons: Generate matches → Preview schedule → Save → Publish.
- **Board** (Court View): spreadsheet-like grid with time rows and one column per court. Each cell shows game no., time, category, Team 1 / Pair 1, Team 2 / Pair 2 and status, in **team colours**.
- **Drag and drop** (Angular CDK) between cells, and onto another cell to swap. The server checks every move against the hard rules and returns warnings for soft-rule breaks before the move is accepted.
- **Lock/unlock** per match, a conflicts panel, and filters by category, team or player (these also give the spec's Category, Team and Player views).
- **Excel export** in a court-by-court layout matching your reference image, plus a print stylesheet.

## 7. Live court management

- Each court shows its next match by **planned time**, not just queue order.
- Admin can **Call** a match (status `called`), which notifies the umpire's phone and the dashboard.
- Starting, finishing, releasing the court and showing the next match reuse phase 1 scoring unchanged. A live match cannot be rescheduled (already enforced).
- Socket events added: `schedule:published`, `schedule:updated`, `court:updated`, `standings:updated`, `match:called`.

## 8. Standings

- **Team standings:** points (= matches won), matches W/L, games, rally points, and per-category points.
- **Category standings:** each pair's W/L inside its category.
- Recalculated whenever a match finishes, is corrected or is given as a walkover. Shown on the admin dashboard, `/live` and the TV board.

## 9. Build order

| Slice | Delivers | Acceptance criteria covered |
|---|---|---|
| **A** ✅ 2026-11-15 | Teams, team assignment for players and pairs, category format/priority/same-team settings, lineup paste-import, match generator, team and category standings | 1–4, 15 |
| **B** ✅ 2026-11-15 | Schedule engine (preview, save, publish, versions), tournament schedule settings, conflicts API, lock/unlock, schedule board with game numbers and times, engine tests | 5–8, 10 (lock), 11 (API), 12 |
| **C** ✅ 2026-11-16 | Schedule board UI with drag and drop (move, swap, tray), lock; Called status and Call button; court status; umpire banner and live sync. **Board filters moved to slice D (done there).** | 9, 10, 13, 14 |
| **D** ✅ 2026-11-17 | Regenerate remaining with diff; Excel export and print | 16, 17 |
| Later | Single elimination and group stage generators (the engine already supports match dependencies) | — |

Each slice ends with tests and a browser check, like phase 1.

## 10. Answers and the reference schedule (2026-11-15)

**Answers:** 4 courts. Start time and match length are configurable. A player is in only **one** pair per tournament. Pairs from the same team never play each other.

**Rules read from the reference schedule image** (3 teams, MD-A…MD-J + WD-A…WD-C, one pair per team per category → 39 matches):
- **Game # = slot × courts + court number** (3:00 slot → games 1–4 on Courts 1–4; 3:30 → 5–8). Empty court slots skip their number, so numbering has gaps (33, 37, 40…).
- **Time column:** "3:00PM - 3:30PM", using the configured start time and match length.
- **Rest:** at least 1 slot between a pair's matches (Jimmy/Ryan: game 1 at 3:00, then game 9 at 4:00).
- **Category–court affinity:** a category's matches mostly stay on one court (MD-I on Court 1, MD-J on Court 4). This is a soft preference in the engine.
- **Excel export:** one block per court with columns Time | Game # | Category/Bracket | Team 1 | Pair 1 | Team 2 | Pair 2. Courts are laid out 2 per row. Team cells and pair cells are filled with the team colour.
- **Player names** are nicknames or full names ("Jiu", "Hannah J."). A pair is shown as "Name / Name" using each player's full name.

## 11. Open questions (answered, see section 10)

- **Q1. Format size.** Are there really 16 levels (MD-A…J, WD-A…F, one pair per team each)? Or fewer levels with several pairs per team (e.g. MD-A/B/C)? Also, how many courts and how long per match? The answer decides whether the day fits (see section 2).
- **Q2. Players in more than one category.** Can one player appear in two pairs (e.g. MD-A and MD-B)? The engine handles it either way, but it changes how long the day takes.
- **Q3. Excel layout.** The spec mentions a "provided reference image" that I don't have. Please send it before slice D.
- **Q4. Same-team matchups.** Skip them by default? I assume yes.
