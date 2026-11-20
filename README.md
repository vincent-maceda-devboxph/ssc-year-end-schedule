# Badminton Tournament Management System

A local-first tournament system. One laptop runs the server. Admins, umpires and spectators connect from phones, tablets or a TV on the same Wi-Fi, with no internet needed.

- **Design notes:** [docs/plan-review.md](docs/plan-review.md), [docs/decisions.md](docs/decisions.md)
- **Status:** Phase 1 ("score a match"). See [What phase 1 covers](#what-phase-1-covers).

## Stack

| Part | Tech |
|---|---|
| `apps/web` | Angular 22 (standalone, signals, zoneless), Angular Material, Socket.IO client |
| `apps/api` | Node 22, Express 5, Mongoose 8, Socket.IO 4, Zod, JWT in HTTP-only cookies |
| `packages/shared` | Scoring engine, match status rules, Zod schemas and DTO types used by both sides |

## Requirements

- Node.js 22+
- MongoDB Community Server 7+ running on `127.0.0.1:27017`, bound to localhost only (Windows installs it as the `MongoDB` service)

## First run

```bash
npm install
npm run build
npm start
```

On a fresh database the server creates a super admin and **prints the password once in the console**:

```
Created first super admin. Username: admin  Password: ...
```

To choose the password yourself, set `ADMIN_PASSWORD` before the first start, or create or reset admins at any time:

```bash
npm run create-admin -- <username> <password> [super_admin|tournament_admin]
```

The console then lists the addresses phones should use, for example `http://192.168.1.100:3000/umpire`.

See [docs/user-guide.md](docs/user-guide.md) for step-by-step instructions for organisers, umpires and spectators (also in the app at `/help`).

## Development

```bash
npm run dev:api     # API on :3000 (tsx watch)
npm run dev:web     # Angular dev server on :4200, proxies /api and /socket.io to :3000
npm test            # scoring engine unit tests + API integration tests
npm run e2e         # builds, then drives a real browser (Playwright, uses the Edge that ships with Windows)
```

The API tests use a real local MongoDB database named `badminton_test`, which they drop at the start of each run. Set `TEST_MONGO_URI` to use a different one.

## Configuration (environment variables)

| Variable | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | Listens on the LAN |
| `MONGO_URI` | `mongodb://127.0.0.1:27017/badminton` | |
| `ADMIN_PASSWORD` | random | Only used when the database has no users |
| `COOKIE_SECURE` | unset | Set to `1` when serving over HTTPS |
| `HTTPS_KEY` / `HTTPS_CERT` | unset | Paths to a key and certificate to serve HTTPS directly |
| `BACKUP_DIR` | `./backups` | Where backups are written |
| `BACKUP_MIRROR_DIR` | unset | Second copy of every backup (for example a USB stick) |
| `BACKUP_EVERY_MINUTES` | `10` | Automatic backup interval (only when something changed); `0` turns it off |
| `BACKUP_KEEP_AUTO` | `48` | How many automatic backups to keep |

## Team round robin

There are no per-level categories. There are **divisions** (Men's Doubles, Women's Doubles), and each team lists its pairs **in order**. A pair's position in its team's list is its level: the first pair is **A** (MD-A), the second **B** (MD-B), and so on. Pairs in the same position play each other, so with 3 teams and 10 men's + 3 women's pairs each there are 13 positions × 3 team pairings = 39 matches.

1. **Teams & lineup tab:** paste rows from Excel with columns `Team, Division, Player 1, Player 2`, one pair per row (e.g. `Hulk Smashers  MD  Kennith  Zeth`; `MD` = Men's Doubles, `WD` = Women's Doubles). **The order of the rows is the order of each team's pairs.** Click **Check** to see what will be created, then **Import**.
   - Old-style labels such as `MD-C` are read as the division (`MD`); only the row order sets the position.
   - Teams, divisions and players are created when missing and reused when they already exist; each new team gets a colour.
   - Re-importing a list keeps existing pairs where they are; new rows continue after the last position.
   - A player can be in only one pair. If any row has a problem, nothing is saved.
   - The **Lineup by position** grid shows each team's pairs side by side; use the arrows to reorder a team's list.
2. **Matches tab → Generate:** for each pair of teams, the pair at position k plays the other team's pair at position k. Teams with fewer pairs only play the positions both have, and the gap is reported. Running it again never duplicates matches, and **Replace** only touches matches that haven't started (so regenerate after reordering).
3. **Standings tab** (also on `/live`): 1 team point per match won. Ties are broken by game difference, then point difference. Each division also has its own pair table. Standings update live as results come in.

### Scheduling matches to courts and times

On the **Schedule** tab:
1. Set the **start time** (and optionally an end of play), **match minutes**, **rest** in slots (1 = not back-to-back), and a **variation** number. Times are entered and shown in the tournament's timezone (default `Asia/Manila`).
2. **Preview schedule** computes the whole plan without saving. The summary shows how many matches fit, the number of time slots, the estimated finish and the shortest rest. Anything that can't be placed is listed with the reason. The same variation number always gives the same schedule; **Another variation** tries a different one.
3. **Save as draft**, then **Publish** it from the Versions list. Publishing sets each match's court, time and game number, and updates umpires' phones and spectators immediately.

Rules the scheduler never breaks (checked again independently before anything is saved):
- A player is never in two matches at once (checked by player, so a player in two categories is covered).
- A court never hosts two matches at once, and only while it is available.
- A player's matches are at least the rest setting apart.
- Locked, live and finished matches never move.

Game numbers follow your sheet: slot × number of courts + court position. Re-previewing keeps every published match where it still fits, so only what had to change moves. 39 matches on 4 courts take the minimum 10 slots (3:00 PM → 8:00 PM at 30 minutes).

#### Adjusting the plan by hand (drag and drop)

On the **Current plan** board:
- **Drag a match** to another court or time. Drop it **on another match to swap** the two, or **on the tray** ("Not yet scheduled") to take it off the schedule; drag a match from the tray onto a court and time to place it. Empty rows at the bottom let you place matches later in the day.
- The server checks every move. A move that would put a player in two matches at once, double-book a court, use a closed court or run past the end of play is **refused** with the reason. A move that only gives a player less rest than the minimum asks you to **confirm**.
- **Lock** (padlock) keeps a match where it is when you regenerate. Locked, called, live and finished matches cannot be dragged.
- A moved match gets its new game number (slot × courts + court) and everyone sees the change straight away.

#### Calling matches and court status

- **Call to court** (megaphone on the board, the dashboard, or the Matches menu) sets the match to **Called**: the umpire's phone shows a banner and they can start it. A court can have only one called or live match, and a player who is still on court can't be called again. **Cancel call** takes it back.
- Each court shows its status: **Available, Scheduled, Called, Ongoing, Completed or Unavailable**. Closing a court (Courts tab) is refused while a match is called or live there; closed courts are left out of the next schedule preview.

#### Rescheduling the rest of the day

When a match runs long or something changes, use **Reschedule: nothing before** on the Schedule tab (press **Now** to use the current time), then **Preview schedule**:
- Everything that can still move is placed at that time or later. **Live, called, locked and finished matches stay exactly where they are**, and matches already at or after that time keep their slot when they still fit.
- A **before → after table** lists every match that is already in the published plan and would change court or time, so you can see the effect before anything is saved. The summary shows the new estimated finish.
- Closing a court, a pair or team withdrawing, a different match length or rest rule all work the same way: preview shows what changes and what no longer fits, **Save as draft**, then **Publish**. Matches of a withdrawn pair are taken off the schedule. Umpires' phones and spectators update when you publish.

#### Excel, print and filters

- **Excel** downloads `schedule-<tournament>.xlsx`: sheet **Schedule** has one block per court (two side by side) with Time, Game #, Category/Bracket, Team 1, Pair 1, Team 2, Pair 2 in team colours; sheet **All matches** is one filterable table with status, score and winner.
- **Print** prints the board only (landscape): settings, tray and buttons are hidden.
- **Filters** above the board highlight the matches of one division, one team, or a player, pair or level (type "MD-A"); the rest are dimmed.

Everything in the scheduling plan is now built.

#### Order of pairs and waiting time

The schedule settings have an **Order of pairs** choice: *lowest pairs first* (the default: MD-F, MD-E … and the top pair MD-A plays last), *top pair first*, or no preference. Whatever you choose, the planner keeps the day as short as possible and then prefers plans where each pair plays its matches close together, so players arrive, play and leave instead of waiting hours between matches. It tries several orderings and keeps the best.

#### Schedule list views and priority

The **List** layout in the Schedule tab shows the same matches as a table, grouped by time, division, team or player (the filters apply). A division's **priority** (Divisions tab; lower = earlier) is a soft preference: matches already in the published plan keep their slot, so the new priority applies when you rebuild the schedule.

## Groups and knockout

Open the **Groups & knockout** tab. A round-robin division can be split into groups (snake order by seed); matches are then generated inside each group and standings show one table per group. A **knockout** division either has its own entries (best seeds get byes) or takes the group qualifiers (winners cross over with the other group's runners-up). Winners (and, with a third-place match, losers) move on automatically as results are entered; undecided sides show **TBD** and the match cannot be started, called or given a walkover until both sides are known. The scheduler places each round after the matches that feed it, with the normal rest time. A semifinal winner can be changed by a correction only until the next match has started. Spectators get a **Brackets** tab.

## Corrections, backups and admin accounts

- **Corrections:** an admin can correct a finished result (Matches tab). A reason is required; the old and new result go to the audit log, standings and any knockout advancement update.
- **System page:** backups (create, download, restore with an automatic safety backup and rollback), a data integrity check, the audit log and a QR code for the spectator link.
- **Admin accounts:** super admins can add admins, reset passwords and sign others out; umpires use per-court 6-digit codes plus their name (no accounts).
- **Reports and import:** the Reports tab prints or exports results; lineups can be pasted or loaded from CSV/Excel (rows in order = pair rank; `MS`/`WS` rows with one player are singles). Tournaments can be duplicated as a template.

## Match-day flow

1. **Admin** (`/admin`): create the tournament, then add categories (scoring presets), players, pairs and courts.
2. **Courts tab:** generate a 6-digit code for each court and pick this laptop's Wi-Fi address. Each court shows a QR code to print or display.
3. **Matches tab:** create matches and assign them to courts. Use ↑/↓ to reorder each court's queue.
4. Set the tournament status to **active**. Umpires and spectators only see active tournaments.
5. **Umpire:** scans the court's QR code, enters the code and their name, then sees the court's current match. They start it, tap the big buttons to score, undo, and submit.
6. **Spectators:** open `/live`. A TV can show `/board/<tournamentId>`.

## How scoring stays correct

- Every tap sends `{actionId, expectedVersion}`. The server checks, in this order:
  1. the `actionId` has already been applied → returns the current state (a retry never adds a second point);
  2. the version is stale → `409` with the current state;
  3. the badminton rules forbid the command → `422`.
  Otherwise it applies the command in one conditional MongoDB update. See `apps/api/src/modules/scoring/scoring.service.ts`.
- The score is always recomputed from the action log by a pure function (`packages/shared/src/scoring.ts`), so undo works across game boundaries.
- A database index ensures a court can't have two live matches at once.
- One umpire session controls a match. Another phone on the same court must press **Take over**, which is audited.
- Changes are saved to the database before they are broadcast. Clients ignore updates older than the version they already hold, and refetch after reconnecting.
- When the phone is offline, the scoring buttons are disabled.

## What phase 1 covers

Covered:
- Admin and umpire sign-in, with PIN lockout and court-code rotation
- Tournaments, categories, players, pairs and courts
- Manual match creation, court queues, walkover and cancel
- Live umpire scoring
- Real-time admin dashboard, spectator view and TV scoreboard
- Audit log of admin actions

Not yet (later phases, see [docs/plan-review.md §3](docs/plan-review.md)):
- Round-robin, group and knockout generation
- Standings
- Result corrections UI
- Backup and restore
- CSV import
- Team events
- Singles in the UI (the data model already supports it)

## Network notes

- Express serves the built Angular app, the API and Socket.IO on one port, so CORS isn't needed.
- Fonts and icons are bundled, so nothing loads from the internet.
- On Windows, set the Wi-Fi network profile to **Private** and allow the app port through the firewall.
- Turn off router client/AP isolation.
- Turn off laptop sleep on event days.
- On plain HTTP, phones can't keep their screen awake automatically. Ask umpires to set auto-lock to "Never" during matches.
