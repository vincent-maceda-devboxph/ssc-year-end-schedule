# Player schedule website

A static, read-only page where players find their matches: search by name, filter by division, level (MD-E), team, court, time of day and day, view as a timeline or by court, save their name, and add a match to their phone calendar. Built with Bootstrap 5 and Bootstrap Icons (bundled in `vendor/`, so nothing loads from the internet except the page itself). No server, no database, no build step.

It shows the schedule **as it was when you exported it**. It does not update by itself and shows no scores.

## Update the data (on the event laptop)

The tournament database must be reachable (the app's MongoDB). From the project folder:

```bash
npm run export:site                      # newest tournament, its published schedule
npm run export:site -- --version 4       # a saved version instead of the published plan
npm run export:site -- --tournament <id> # a specific tournament
```

This rewrites `schedule-site/schedule.json` and the team logos in `schedule-site/logos/`. It only reads the database.

Open `schedule-site/index.html` through any web server to check it before publishing (opening the file directly will not load the data in most browsers).

## Deploy on Render (free static site)

1. Put the project (or just the `schedule-site` folder) in a GitHub repository.
2. In Render: **New → Static Site**, pick the repository.
3. Settings:
   - **Build command:** leave empty (or `echo ok`)
   - **Publish directory:** `schedule-site` (or `.` if the repository contains only this folder)
4. **Create Static Site.** Render gives you an address like `https://your-name.onrender.com`. Share that link with the players.

To change the schedule later: run `npm run export:site`, commit the changed `schedule.json` (and `logos/`), and push. Render redeploys in about a minute.

## Files

- `index.html`, `app.js`, `site.css`: the page, its logic and a small teal theme on top of Bootstrap
- `vendor/`: Bootstrap 5.3 and Bootstrap Icons 1.11 (copied in, nothing to install)
- `schedule.json`, `logos/`: the exported data

## Notes

- Everything in `schedule.json` is public to anyone with the link: names, teams, times and courts. Nothing from the admin app is included (no standings, scores, phone numbers or accounts).
- Players can open a filtered view and share its link (the address keeps the search and filters).
- "Next up" and the dimming of earlier matches use the viewer's own clock.
