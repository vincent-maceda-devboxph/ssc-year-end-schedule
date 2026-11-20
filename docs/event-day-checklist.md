# Event-day checklist

## A week before
- [ ] Do a **full dry run** with the real router and **4 phones as umpires**, a tablet for admin, a few "spectator" phones, and the TV: score a few matches on all 4 courts at once.
- [ ] Try the **drag-and-drop** on the actual tablet (press and hold a match for a moment, then drag).
- [ ] Check **Android and iPhone** browsers both open the umpire page and the QR code.
- [ ] Pause Windows updates. Plug a **USB stick** in and set `BACKUP_MIRROR_DIR`.
- [ ] Print the court **QR codes** (Courts tab) and keep the court **codes** written down (they are shown once; make a new one if lost).

## Day before
- [ ] `npm run doctor` shows no FAIL (fix the warnings that matter: firewall, Private network, second backup copy).
- [ ] Enter the lineup (Teams & lineup → paste → Check → Import). Look at the lineup grid: every team has the pairs you expect, in the right order.
- [ ] Courts tab: all courts added and open. Generate each court's code.
- [ ] Matches → Generate. Schedule tab → set start time and match length → Preview → Save → Publish.
- [ ] Set the tournament status to **active** (umpires and spectators only see active tournaments).
- [ ] **Admin → System → Back up now**, label it "ready".

## At the venue (30 minutes before)
- [ ] Laptop plugged in, on Ethernet if possible, **network set to Private**, sleep off.
- [ ] Router: client isolation **off**. Start the server. Read the address from the console banner or **Admin → System**.
- [ ] Project the **TV scoreboard** (`/board/<id>`) or show the QR for `/live`.
- [ ] Each umpire: scan the court QR, enter the 6-digit court code and their name. Admin dashboard shows each court's umpire as online.
- [ ] One umpire scores a practice point and undoes it.

## During the tournament
- **Call to court** (megaphone) when the next match should come on: the umpire's phone shows the banner.
- To move a match: drag it. A red message means the rule is broken (player already playing, court busy); a confirm box means short rest, your call.
- **Lock** (padlock) matches you do not want regeneration to move.
- A match runs long? Schedule tab → **Reschedule: nothing before** (press Now) → Preview → check the before/after list → Save as draft → Publish.
- A pair withdraws? Players & pairs → Withdraw. Preview the schedule; their matches are taken off.
- A score was entered wrong? Matches → **Finished** → ⋮ → **Correct result…** (needs a reason; it is logged).
- Court broken? Courts tab → switch it off (only if no match is on it), then reschedule.

## If something goes wrong
| Problem | What to do |
|---|---|
| Phone shows "Offline" | Wi-Fi dropped. Scoring buttons stay locked until it reconnects; the score is safe on the laptop. Check the phone is on the event Wi-Fi. |
| Umpire's phone died / swapped | New phone: scan QR, enter code and name, open the match, **Take over**. |
| Two phones show different scores | The laptop is always right. Pull to refresh or tap ⋮ → Refresh. |
| Server window closed / laptop restarted | Start it again (`start-server.cmd`, or it starts itself if the boot task is installed). Phones reconnect by themselves. Open Admin → System → **Data check**. |
| Data looks wrong / something was deleted | Admin → System → **Restore…** the latest backup (a safety copy is made first). Anything after that backup (a few minutes at most) must be re-entered. |
| Laptop dies | On another laptop: install, copy the newest `.json.gz` from the USB stick to its `backups` folder, start, Admin → System → Restore. |
| Forgot admin password | `npm run create-admin -- admin <new password> super_admin` |

## After
- [ ] Admin → System → **Back up now**, label it "final". Keep it.
- [ ] Download the **schedule to Excel**; check Standings and the audit log (System page).
- [ ] Set the tournament to **completed** (or archived).
