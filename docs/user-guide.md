# How to use the Badminton Tournament app

Three kinds of people use the app: **organisers** (admin), **umpires** and **spectators**. Everyone opens the same address in a phone or laptop browser. The organiser's laptop runs the server; start it with `start-server.cmd`. It prints the address to share, such as `http://192.168.1.20:3000`.

## 1. Organiser: before the event

1. **Start the server** on the laptop. Everyone joins the same Wi-Fi. Run `npm run doctor` if phones cannot connect (it checks the firewall and network type).
2. **Sign in** at `/admin` with the admin account. The first-run password is printed in the server window.
3. **Create a tournament** (Tournaments page → New). Set the name, venue and status *Active*.
4. **Add courts** (Courts tab). Add one per court. Optionally set *open from / until* for a court that is only free part of the day. Each court gets a **6-digit umpire code**, shown there; print or read it out to the umpire.
5. **Add teams, logos and pairs** (Teams & lineup tab):
   - Add a team, then click its logo square to upload a logo (PNG, JPEG or WebP; it is shrunk automatically). Without a logo the team shows its initials on its colour.
   - Under **Add pairs to a team**, pick the team and a division (Men's Doubles, Women's Doubles, Mixed, Men's or Women's Singles, or your own), paste its pairs one per line, for example `Ana Cruz / Bea Lim`, and click Add.
   - **The order of the lines is the rank**: the first line is pair A, the next B. Pairs of the same rank play each other (MD-A vs MD-A). Separators `/`, `&`, `and`, `-`, a comma or a tab all work, and numbering is ignored.
   - Repeat for the next division or team. New teams and divisions are created for you. A player can be in only one pair.
   - A whole table or a CSV/Excel file (`Team | Division | Player 1 | Player 2`) can still be imported lower on the same tab.
6. **Review divisions** (Divisions tab): change the scoring rules (for example best of 3 to 21) and the priority (a lower number is scheduled earlier).
7. **Generate matches** (Matches tab → Generate). Every team plays every other team once; one team point per match won.
8. **Plan the day** (Schedule tab):
   - Set the **start time**, **match duration**, **rest between a player's matches** and the number of courts in use.
   - Click **Preview schedule**. Nothing changes yet. Check the board and conflicts.
   - Click **Save**, then **Publish**. Games are numbered across courts in time order.
9. **Optional: groups and knockout** (Groups & knockout tab):
   - Pick a round-robin division, choose the number of groups and click **Split into groups**, then generate matches again.
   - Add a **Knockout** division fed by that division (or with its own entries), then **Generate bracket** once the groups are finished.
10. **Take a backup** (System page → Create backup). Set `BACKUP_MIRROR_DIR` to a USB stick path for a second copy.

## 2. Organiser: on match day

- **Live tab**: every court, what is playing, and what is next.
- **Schedule tab**
  - *Drag* a match to another court or time. Drop it on another match to swap, or on the tray to take it off the schedule.
  - The padlock **locks** a match so a reschedule never moves it.
  - The megaphone **calls** a match to its court; the court then shows *Called* and the umpire starts it.
  - **Delay?** Enter the new earliest time and use *Reschedule*. Matches in progress, called and finished stay where they are.
  - **List** layout shows the same matches as a table by time, division, team or player. Use the filters to find a player, pair or level such as `MD-A`.
  - **Excel** exports one block per court. **Print** prints the board.
- **Matches tab**: walkover, cancel, or **Correct result** for a finished match. A reason is required and the change is logged.
- **Standings tab**: team points and pair tables, updated live. Ties: wins, then head to head, then game difference, then point difference.
- **Reports tab**: print or export results.
- **Courts tab**: switch a court off if it becomes unavailable and reschedule.

## 3. Umpire

1. Open the app on your phone and tap **Umpire** (or go to `/umpire`).
2. Type your court's **6-digit code** and **your name**, then tap **Start umpiring**. The code identifies the court, so there is nothing else to pick.
3. Your court shows its match. Tap **Start match**, then tap the side that wins each rally. The app handles serving, the interval, changing ends and the decider.
   **Doubles service:** at the start of every game a card asks **Who serves first?** Pick the serving pair, the server and the receiver, then **Confirm server**. After that the yellow line shows who serves and from which court, each pad lists the two players with **R** (right court) or **L** (left court), and the serving player has the shuttle icon. The app follows the rules: the server serves from the right court when their side's score is even and from the left when it is odd; the serving side keeps the serve and swaps courts when it wins a rally; the other side takes the serve when it wins. **Change** corrects the choice if you set it wrongly. Spectator cards and the TV board show the current server too.
4. Tapped the wrong side? **Undo last point**. A repeated tap is ignored by the server, so it is safe on a slow connection.
5. **Pause match** / **Resume** for a stoppage. **Swap sides on screen** flips the display to match where you are sitting.
6. At the end tap **Submit result**. If the court has another match it appears as **Next match**.
7. If another umpire has the match, **Take over** moves it to you. Tap **Refresh** if the screen looks out of date; it normally updates by itself.

## 4. Spectators

- Scan the QR code from the System page, or open `/live`. Pick the tournament.
- **Courts**: live scores. **Upcoming**: what plays next. **Results**: finished matches. **Standings**: team and pair tables. **Brackets**: the knockout tree, with TBD until a side is decided.
- For a big screen, open `/board/<tournament id>` on the TV: a large live scoreboard.

## 5. Admin accounts and safety

- **Users** (super admin): add admins, reset passwords, and sign others out.
- **System**: backups (download, restore with an automatic safety backup), a data integrity check, the audit log of every change, and the spectator QR code.
- **Event-day checklist**: see `docs/event-day-checklist.md`.

## Troubleshooting

| Problem | Try |
|---|---|
| Phones cannot open the address | Same Wi-Fi? Run `npm run doctor`; allow port 3000 in the firewall; set the Wi-Fi network to *Private*. |
| "Waiting for opponents" on a knockout match | The matches before it are not finished yet. |
| A move is refused | The message names the reason: player overlap, rest time, court closed, locked match or an earlier round. |
| Wrong result entered | Matches tab → **Correct result** with a reason. |
| Something went badly wrong | System → Backups → restore the last backup. |

## Changing the lineup after the schedule is published

All of this is on the **Teams & lineup** tab, under *Lineup by position*. **The published schedule is not changed:** every match keeps its court and time, and only the names in it update.

- **Substitute a player:** click the pencil next to a pair, pick the replacement from the team (or **+ New player…**), then **Save change**.
- **Swap players between two pairs:** click the pencil and pick a player who is already in another pair. The app asks to swap the two players.
- **Change the order of pairs:** use the up and down arrows. Matches that have not started follow the new order, so the pair now in position MD-A plays the MD-A matches, in the same slots.
- **Fix a spelling:** Players & pairs tab, **Rename** next to the player. The pair names update too.
- Matches already finished keep the pairs that played them. A pair with a match on court right now cannot be changed until that match ends.
- After a change the app checks the schedule. If a player now has overlapping or back-to-back matches, a red list tells you which; fix them by dragging on the Schedule tab.

## Playing a level earlier (for example MD-E)

On the **Schedule** tab, pick the levels in **Play these earlier**, then **Preview schedule**. Those matches take the earliest slots, and everything else is re-planned around them without making the day longer. The preview lists what moved. **Save as draft** and **Publish** when you are happy. Matches that are locked (padlock), called, live or finished stay exactly where they are, so lock anything you do not want moved before you preview.

## Looking at a saved version before publishing

On the **Schedule** tab, scroll to **Versions** and click **View** next to any version. It opens on the board, with a list of every match whose court or time differs from the published plan. **Publish this version** is there when it is a draft; **Close** goes back to the current plan.
