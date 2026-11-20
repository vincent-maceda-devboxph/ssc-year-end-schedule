# Setting up the event laptop

One Windows laptop runs everything. Phones, tablets and a TV connect to it over the venue's Wi-Fi. No internet is needed.

## 1. Install once

| What | Notes |
|---|---|
| **Node.js 22+** | nodejs.org, "install for all users" if you want the start-at-boot task |
| **MongoDB Community Server** | Install as a Windows service. It listens on `127.0.0.1` only, which is what you want. You do **not** need MongoDB Database Tools or a replica set: backups are built in. |
| **This program** | Copy the folder to the laptop, then in the folder: `npm install` and `npm run build` |

First start creates an admin account and prints its password **once** in the console (or set `ADMIN_PASSWORD` before the first start). More admins: **Admin → System** is for backups; create more accounts from the **Users** page (Super Administrator) or with `npm run create-admin -- <name> <password>`.

## 2. Make the laptop event-proof (Administrator PowerShell)

Open PowerShell with **Run as administrator** in the program folder. Each script changes one thing and says what it did. **Read a script before running it**; they are short.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\prepare-laptop.ps1      # no sleep, lid does nothing (plugged in)
powershell -ExecutionPolicy Bypass -File scripts\windows\make-network-private.ps1                       # lists connections
powershell -ExecutionPolicy Bypass -File scripts\windows\make-network-private.ps1 -InterfaceAlias "Wi-Fi"   # only for the event router
powershell -ExecutionPolicy Bypass -File scripts\windows\open-firewall.ps1 -Port 3000                  # one port, Private networks only
powershell -ExecutionPolicy Bypass -File scripts\windows\install-startup-task.ps1 -BackupMirrorDir E:\badminton-backups
```

- **Private network:** Windows blocks phones on networks it calls "Public". The venue router must be "Private". Never do this for a café or hotel network.
- **Start at boot:** `install-startup-task.ps1` makes a scheduled task that starts the server 30 s after boot and restarts it if it stops. Use `-AtLogon` if Node is installed only for your user. Log: `logs\server.log`. Remove with `uninstall-startup-task.ps1`.
- Or start it by hand: double-click `scripts\windows\start-server.cmd` (runs the check first, then the server; closing the window stops it).
- **Windows Update:** pause updates for a week before the event. A forced restart in the middle of a match stops scoring.

## 3. Check everything

```bash
npm run doctor
```

Read-only. It checks Node, the build, MongoDB, the port, the laptop's Wi-Fi address, the firewall and network type, the backup folders and the disk, and tells you the fix for each problem. Run it the day before and again at the venue.

## 4. Router

- Laptop on **Ethernet** if possible; phones on Wi-Fi.
- **Turn off "client isolation" / "AP isolation"**, or phones cannot see the laptop.
- Give the laptop a **fixed address** (DHCP reservation) so QR codes and bookmarks keep working.
- Test with 4+ phones **before** the event.

## 5. Settings (environment variables)

| Variable | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `MONGO_URI` | `mongodb://127.0.0.1:27017/badminton` | keep it on the laptop |
| `ADMIN_PASSWORD` | random | only used when the database has no users |
| `BACKUP_DIR` | `<program folder>\backups` | |
| `BACKUP_MIRROR_DIR` | none | **set this to a USB stick**: every backup is copied there too |
| `BACKUP_EVERY_MINUTES` | `10` | `0` turns automatic backups off |
| `BACKUP_KEEP_AUTO` | `48` | how many automatic backups to keep (manual and safety copies are never deleted) |
| `HTTPS_KEY`, `HTTPS_CERT` | none | see below |
| `COOKIE_SECURE` | auto | set to `1` only if something else adds HTTPS in front |

## 6. Backups

- Automatic backup every 10 minutes **if something changed**, and within ~15 seconds after each submitted result, correction or published schedule. Files: `backups\backup-<date>-<time>-auto.json.gz`.
- **Admin → System → Back up now** before risky steps (publishing a new schedule, the finals).
- **Restore:** Admin → System → Restore…, type `RESTORE`. It writes a *safety backup of the current data first*, so a restore can itself be undone. A restore that fails half-way rolls back automatically. It refuses while matches are being played unless you tick "Restore anyway".
- Backup files contain the admin password hashes: keep the USB stick safe. Downloading and restoring are for the Super Administrator only.
- **Data check** (System page) looks for impossible data; it runs automatically after every restore.

## 7. HTTPS (optional)

Plain HTTP is the default: simple, and works on every phone. Anyone on the same Wi-Fi could in principle read the traffic (sign-in codes, scores), so use a **private router with a password** and do not publish its password.

Some things only work on HTTPS: phones **keeping the screen on** automatically (Wake Lock) and installing the page as an app. If you want HTTPS:

1. Create a certificate for the laptop's address, for example with [mkcert](https://github.com/FiloSottile/mkcert): `mkcert -install` then `mkcert 192.168.1.100 localhost`.
2. Set `HTTPS_KEY` and `HTTPS_CERT` to the two files and restart. Cookies become Secure automatically; the address now starts with `https://`.
3. **Every phone must trust that certificate**, otherwise it shows a scary warning. With mkcert you must install its root certificate (`rootCA.pem`) on each phone (iOS needs extra steps: install the profile, then enable it under Settings → General → About → Certificate Trust Settings). Test this on the actual phones first. If it is a hassle, stay on HTTP and ask umpires to set Auto-Lock to "Never".

## 8. Not covered

- This is a single-laptop design: if the laptop dies, restore the latest backup on another laptop (copy the `.json.gz` file, start the program, Admin → System → Restore).
- Nothing here has been tested on your actual router or phones: do a full dry run (see the event-day checklist).

## 9. Share the live pages over the internet (free)

The server stays on the event laptop. A tunnel gives it a public address so people outside the venue can follow along.

1. Start the app as usual (port 3000). The laptop needs internet for this (a phone hotspot works).
2. Install the tunnel tool once: `winget install Cloudflare.cloudflared`
3. In a second terminal run: `cloudflared tunnel --url http://localhost:3000`
4. It prints an address such as `https://random-words.trycloudflare.com`. Share:
   - `https://…/live/<tournament id>` – live scores, **schedule**, upcoming matches, results, brackets
   - `https://…/board/<tournament id>` – the TV scoreboard (with the QR code)

**What internet visitors can and cannot do.** The server notices requests that arrive through a tunnel or proxy
(headers such as `cf-connecting-ip` or `x-forwarded-for`) and lets them open only the spectator pages and read
the data those pages need. `/admin`, `/umpire`, sign-in, standings, reports and every write answer "not found"
(pages redirect to `/live`). Phones on the venue Wi-Fi are unaffected.

Setting `PUBLIC_READONLY`:

| Value | Meaning |
|---|---|
| `auto` (default) | Restrict requests that came through a tunnel or proxy |
| `on` | Also restrict any request addressed to a public host name |
| `off` | No restriction. Use this for a normal cloud deployment where you sign in over the internet |

The address changes each time the tunnel starts. If the laptop sleeps or loses internet, the public link stops until it is back; scoring on the venue network keeps working.
