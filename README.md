# Keka regularise

Regularises your Keka attendance automatically once a month, so you don't have to click through each day.

On the day you choose (default: the 25th at 8 PM), it opens your Keka attendance log in the background and finds:

- days you arrived late, or worked less than 9 hours
- optionally, days with no time entries at all

For each of those days it submits a regularisation request with your shift times (default 09:30–18:30) and a note. Weekends and holidays are skipped. It never submits the same day twice. When it finishes, it shows a Mac notification with the result.

> Only use this for days you actually worked. If a day with no entries was leave, apply for leave instead, or add it to `skipDates` (see below).

## Requirements

- macOS
- [Node.js](https://nodejs.org) 18 or newer (`node -v` to check)
- Google Chrome (recommended; otherwise a browser is downloaded automatically)

## Install (about 2 minutes)

1. Open **Terminal** and run:
   ```bash
   git clone https://github.com/AkshaySharma008/keka-regularise.git ~/keka-regularise
   ```
2. Then run:
   ```bash
   bash ~/keka-regularise/install.sh
   ```
3. Answer the questions. Press Enter to accept the default shown in `[brackets]`.
4. A Chrome window opens. Log in to Keka as usual (Google, password or mobile). **Don't close the window**: it closes on its own once you're in.
5. You'll see a preview of the days it would regularise. Choose whether to submit them now and whether to turn on the monthly run.

Everything lives in `~/keka-regularise`. Keep it there: macOS blocks background jobs from reading Desktop, Documents and Downloads.

## Updating

```bash
cd ~/keka-regularise && git pull && npm ci
```

Your settings, login and history aren't tracked by git, so updating never touches them.

## Everyday commands

Run these from Terminal after `cd ~/keka-regularise`:

| Command | What it does |
|---|---|
| `node keka.js status` | Settings, schedule on/off, login state, recent activity |
| `node keka.js preview` | Lists the days it would regularise. Submits nothing |
| `node keka.js run` | Regularises those days now |
| `node keka.js login` | Log in again (when you get a "session expired" notification) |
| `node keka.js schedule` | Turns on the monthly run |
| `node keka.js unschedule` | Turns off the monthly run |
| `node keka.js setup` | Re-runs the setup questions |

## Changing settings

Edit `~/keka-regularise/config.json`, or run `node keka.js setup` again.

| Setting | Meaning |
|---|---|
| `baseUrl` | Your company's Keka address |
| `inTime`, `outTime` | Times written into each request (24-hour) |
| `note` | Note added to each request |
| `minEffectiveMinutes` | Days with fewer effective minutes than this get regularised (540 = 9h) |
| `regulariseLateArrival` | Regularise days marked late |
| `includeNoEntryDays` | Also regularise days with no time entries |
| `skipDates` | Days to never touch, written as Keka shows them, e.g. `["Wed, 14 Oct"]` |
| `scheduleDay`, `scheduleTime` | When the monthly run happens. Run `node keka.js schedule` after changing these |

## Good to know

- **Your Mac must be on.** If it's asleep at the scheduled time, the run happens when it wakes. If it's shut down, that month is skipped. Run `node keka.js run` by hand if that happens.
- **Your login expires now and then.** You'll get a notification. Run `node keka.js login`.
- **Each run scans the last 30 days and the whole previous month**, so nothing falls between runs.
- **Logs** are in `~/keka-regularise/logs`. If a day fails, a screenshot is saved there.
- **Your login stays on your Mac** (in `auth.json` and `keka-profile/`). Only Keka's session is kept. If you sign in with Google, the Google cookies are deleted right after login. Nothing is sent anywhere except Keka itself, and no Claude or browser extension is involved. Never share those files or copy your `~/keka-regularise` folder to someone, because they work like your logged-in Keka session. Point people to this repo instead. Those files are git-ignored, so they can't be committed by accident.

## Uninstall

```bash
cd ~/keka-regularise && node keka.js unschedule && cd ~ && rm -rf ~/keka-regularise
```
