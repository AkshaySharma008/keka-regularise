#!/usr/bin/env node
// Keka attendance regulariser (macOS).
//
//   node keka.js setup        first-time setup: settings, login, preview, monthly schedule
//   node keka.js login        log in again (when the session expires)
//   node keka.js preview      show which days would be regularised, submit nothing
//   node keka.js run          regularise those days now
//   node keka.js schedule     turn on the monthly run (uses the day/time in config.json)
//   node keka.js unschedule   turn off the monthly run
//   node keka.js status       show settings, schedule, login state and recent log
//
// Options for preview/run:
//   --period SEP       scan only this tab (default: "30 DAYS" + previous month)
//   --include-today    also regularise today (scheduled runs do this; they run after work)
//   --headed           show the browser while it runs
//   --notify           show a macOS notification with the result

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const CONFIG_FILE = path.join(DIR, 'config.json');
const PROFILE_DIR = path.join(DIR, 'keka-profile');
const STATE_FILE = path.join(DIR, 'submitted.json');
const AUTH_FILE = path.join(DIR, 'auth.json');
const LOG_DIR = path.join(DIR, 'logs');
const LABEL = 'com.keka-regularise';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const DEFAULTS = {
  baseUrl: 'https://wealthindia.keka.com',
  inTime: '09:30',
  outTime: '18:30',
  note: 'Regularising attendance as per shift timings.',
  minEffectiveMinutes: 540,
  regulariseLateArrival: true,
  includeNoEntryDays: false,
  skipDates: [],
  scheduleDay: 25,
  scheduleTime: '20:00',
};

const [command = 'help', ...args] = process.argv.slice(2);
const flag = (name) => args.includes(name);
const periodIdx = args.indexOf('--period');
const PREV_MONTH = MONTHS[(new Date().getMonth() + 11) % 12];
// By default scan the last 30 days and the whole previous month, so nothing falls between monthly runs.
const periods = periodIdx >= 0 ? [args[periodIdx + 1].toUpperCase()] : ['30 DAYS', PREV_MONTH];

function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  return { ...DEFAULTS, ...saved };
}
let config = loadConfig();
const logsUrl = () => `${config.baseUrl.replace(/\/+$/, '')}/#/me/attendance/logs`;

function log(...m) {
  const line = `[${new Date().toISOString()}] ${m.join(' ')}`;
  console.log(line);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, `${new Date().toISOString().slice(0, 7)}.log`), line + '\n');
}

function notify(message) {
  if (!flag('--notify')) return;
  const esc = (t) => t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  spawnSync('osascript', ['-e', `display notification "${esc(message)}" with title "Keka regularise"`]);
}

function loadSubmitted() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

// Row labels look like "Mon, 19 Oct" with no year; work out the year so next year's dates don't collide.
function dateKey(label) {
  const now = new Date();
  const month = MONTHS.indexOf(label.split(' ')[2].slice(0, 3).toUpperCase());
  const year = month > now.getMonth() ? now.getFullYear() - 1 : now.getFullYear();
  return `${label} ${year}`;
}

function toMinutes(text) {
  const m = /(\d+)h\s*(\d+)m/.exec(text || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// ---------- browser ----------

async function launch(headed) {
  const { chromium } = require('playwright');
  const opts = { headless: !headed, viewport: { width: 1400, height: 900 }, ignoreDefaultArgs: ['--enable-automation'] };
  // Prefer the real Chrome install: Google sign-in often refuses Playwright's bundled Chromium.
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, { ...opts, channel: 'chrome' });
  } catch {
    return await chromium.launchPersistentContext(PROFILE_DIR, opts);
  }
}

async function login() {
  const ctx = await launch(true);
  const page = ctx.pages()[0] || (await ctx.newPage());
  let closed = false;
  page.on('close', () => { closed = true; });
  await page.goto(logsUrl());
  console.log('\nLog in to Keka in the browser window that just opened.');
  console.log('Do NOT close it yourself - it closes on its own once you are in.\n');
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline && !closed) {
    const onApp = page.url().startsWith(config.baseUrl) && !/Account\/Login/i.test(page.url());
    if (onApp && (await page.getByText('Attendance Log').count().catch(() => 0))) break;
    if (onApp && !page.url().includes('/attendance/logs')) await page.goto(logsUrl()).catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (closed || Date.now() >= deadline) {
    console.log('Login not completed (window closed or timed out). Run: node keka.js login');
    await ctx.close().catch(() => {});
    return false;
  }
  await page.waitForTimeout(3000);
  await saveKekaOnlySession(ctx);
  console.log('Logged in. Session saved.');
  await ctx.close();
  return true;
}

const isKeka = (host) => /(^|\.)keka\.com$/.test(host.replace(/^\./, ''));

// Signing in with Google leaves Google account cookies in the browser. The tool only needs Keka's,
// so drop everything else from the profile and save only Keka's session. Keka's auth cookies are
// session cookies, which a browser drops on exit, hence the explicit file.
async function saveKekaOnlySession(ctx) {
  const keep = (await ctx.cookies()).filter((c) => isKeka(c.domain));
  await ctx.clearCookies();
  await ctx.addCookies(keep);
  const state = await ctx.storageState();
  state.origins = state.origins.filter((o) => isKeka(new URL(o.origin).hostname));
  fs.writeFileSync(AUTH_FILE, JSON.stringify(state), { mode: 0o600 });
}

// Reads every row of the attendance log table.
async function readRows(page) {
  return page.evaluate(() => {
    const out = [];
    // Days with time entries: the clickable rows with a Regularize link in their dropdown.
    for (const row of document.querySelectorAll('div.attendance-logs-row')) {
      const lines = row.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
      out.push({ kind: 'worked', label: lines[0], text: lines.join(' | ') });
    }
    // Days without time entries, weekly-offs and holidays: rows with a "..." menu.
    for (const row of document.querySelectorAll('div.on-hover.border-bottom.justify-content-between')) {
      if (row.closest('.attendance-logs-row')) continue;
      const text = row.innerText.replace(/\s+/g, ' ').trim();
      const label = (text.match(/[A-Z][a-z]{2}, \d{2} [A-Z][a-z]+/) || [])[0];
      if (!label) continue;
      out.push({ kind: /No Time Entries Logged/.test(text) ? 'noentry' : 'off', label, text });
    }
    return out;
  });
}

const now = new Date();
const TODAY_PREFIX = `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][now.getDay()]}, ${String(now.getDate()).padStart(2, '0')} `;

function needsRegularising(row) {
  if (config.skipDates.includes(row.label)) return null;
  // Today is still in progress unless the run happens after work.
  if (row.label.startsWith(TODAY_PREFIX) && !flag('--include-today')) return null;
  if (row.kind === 'noentry') return config.includeNoEntryDays ? 'no time entries' : null;
  if (row.kind !== 'worked') return null;
  const parts = row.text.split(' | ');
  const effective = toMinutes(parts[1]);
  const reasons = [];
  if (/late/i.test(row.text) && config.regulariseLateArrival) reasons.push('late arrival');
  if (effective !== null && effective < config.minEffectiveMinutes) reasons.push(`only ${parts[1]}`);
  return reasons.length ? reasons.join(', ') : null;
}

// A row's details dropdown stays open after the form closes and covers the next row.
async function resetPage(page) {
  await page.getByRole('button', { name: 'Not Now' }).click({ timeout: 500 }).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  if (await page.locator('div.attendance-logs-row.open').count()) {
    await page.getByText('Logs & Requests').click().catch(() => {});
  }
  await page.waitForTimeout(300);
}

async function openForm(page, row) {
  await resetPage(page);
  if (row.kind === 'worked') {
    const r = page.locator('div.attendance-logs-row').filter({ hasText: row.label }).first();
    await r.scrollIntoViewIfNeeded();
    await r.click();
    await r.locator('a.text-link', { hasText: 'Regularize' }).click();
  } else {
    const r = page.locator('div.on-hover.border-bottom.justify-content-between').filter({ hasText: row.label }).first();
    await r.scrollIntoViewIfNeeded();
    await r.locator('a.icon-click').click();
    await page.locator('.dropdown-menu:visible').getByText('Regularize', { exact: true }).first().click();
  }
  await page.getByText('Request Attendance Regularization').waitFor();
}

async function fillAndSubmit(page, submit) {
  await page.getByText('Add/update time entries to adjust attendance logs.').click();
  await page.getByRole('button', { name: '+Add Log' }).click().catch(() => page.getByText('+Add Log').click());
  const times = page.locator('input[type=time]');
  await times.first().waitFor();
  const n = await times.count();
  await times.nth(n - 2).fill(config.inTime);
  await times.nth(n - 1).fill(config.outTime);
  await page.getByPlaceholder('Enter note').fill(config.note);
  if (!submit) {
    await page.getByRole('button', { name: 'Cancel' }).click();
    return 'ok (preview)';
  }
  await page.getByRole('button', { name: 'Request' }).click();
  await page.getByText('Request Attendance Regularization').waitFor({ state: 'hidden', timeout: 15000 });
  return 'submitted';
}

async function regularise(submit) {
  const ctx = await launch(flag('--headed'));
  if (fs.existsSync(AUTH_FILE)) {
    const { cookies } = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    await ctx.addCookies(cookies);
  }
  const page = ctx.pages()[0] || (await ctx.newPage());
  try {
    await page.goto(logsUrl());
    const loggedIn = await page.getByText('Attendance Log').first().waitFor({ timeout: 30000 }).then(() => true, () => false);
    if (!loggedIn) {
      log('Not logged in (session expired). Run: node keka.js login');
      notify('Keka session expired. Open Terminal and run: node keka.js login');
      process.exitCode = 2;
      return;
    }
    const submitted = loadSubmitted();
    let done = 0;
    const failed = [];
    for (const period of periods) {
      await resetPage(page);
      await page.getByText(period, { exact: true }).first().click();
      await page.waitForTimeout(2500);

      const rows = await readRows(page);
      const targets = rows
        .map((r) => ({ ...r, reason: needsRegularising(r) }))
        .filter((r) => r.reason && !submitted[dateKey(r.label)]);

      log(`${submit ? 'RUN' : 'PREVIEW'} ${period}: ${rows.length} days read, ${targets.length} to regularise`);
      for (const t of targets) log(`  - ${t.label}: ${t.reason}`);

      for (const t of targets) {
        try {
          // The list re-renders after each submit, so give it a moment and retry once on a stale row.
          let result;
          for (let attempt = 1; ; attempt++) {
            try {
              await page.waitForTimeout(1500);
              await openForm(page, t);
              result = await fillAndSubmit(page, submit);
              break;
            } catch (e) {
              if (attempt >= 2) throw e;
              await page.getByRole('button', { name: 'Cancel' }).click({ timeout: 2000 }).catch(() => {});
            }
          }
          log(`  ${t.label}: ${result} (${config.inTime}-${config.outTime})`);
          done++;
          if (submit) {
            submitted[dateKey(t.label)] = new Date().toISOString();
            fs.writeFileSync(STATE_FILE, JSON.stringify(submitted, null, 2));
          }
        } catch (e) {
          failed.push(t.label);
          log(`  ${t.label}: FAILED - ${e.message.split('\n')[0]}`);
          await page.screenshot({ path: path.join(LOG_DIR, `fail-${t.label.replace(/\W+/g, '_')}.png`) });
          await page.keyboard.press('Escape').catch(() => {});
          await page.getByRole('button', { name: 'Cancel' }).click({ timeout: 2000 }).catch(() => {});
        }
      }
    }
    const verb = submit ? 'Regularised' : 'Preview: would regularise';
    notify(failed.length ? `${verb} ${done} day(s). FAILED: ${failed.join(', ')}` : `${verb} ${done} day(s).`);
    if (failed.length) process.exitCode = 1;
  } finally {
    await ctx.close();
  }
}

// ---------- schedule (launchd) ----------

function launchctl(...a) {
  return spawnSync('launchctl', a, { encoding: 'utf8' });
}

function schedule() {
  const protectedDir = ['Desktop', 'Documents', 'Downloads', 'Library/Mobile Documents']
    .map((d) => path.join(os.homedir(), d))
    .find((d) => DIR.startsWith(d + path.sep));
  if (protectedDir) {
    console.log(`This folder is inside ${protectedDir}, which macOS blocks for background jobs.`);
    console.log(`Move it first, e.g.:  mv "${DIR}" ~/keka-regularise`);
    process.exitCode = 1;
    return;
  }
  const [hour, minute] = config.scheduleTime.split(':').map(Number);
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(process.execPath)}</string>
    <string>${esc(path.join(DIR, 'keka.js'))}</string>
    <string>run</string>
    <string>--notify</string>
    <string>--include-today</string>
  </array>
  <key>WorkingDirectory</key><string>${esc(DIR)}</string>
  <key>StandardOutPath</key><string>${esc(path.join(LOG_DIR, 'scheduled.out'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(LOG_DIR, 'scheduled.out'))}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Day</key><integer>${config.scheduleDay}</integer>
    <key>Hour</key><integer>${hour}</integer>
    <key>Minute</key><integer>${minute}</integer>
  </dict>
</dict>
</plist>
`;
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(PLIST, plist);
  const domain = `gui/${process.getuid()}`;
  launchctl('bootout', `${domain}/${LABEL}`);
  const r = launchctl('bootstrap', domain, PLIST);
  if (r.status !== 0) {
    console.log('Could not turn on the schedule:', (r.stderr || r.stdout).trim());
    process.exitCode = 1;
    return;
  }
  console.log(`Scheduled: day ${config.scheduleDay} of every month at ${config.scheduleTime}.`);
}

function unschedule() {
  launchctl('bootout', `gui/${process.getuid()}/${LABEL}`);
  fs.rmSync(PLIST, { force: true });
  console.log('Monthly run turned off.');
}

function status() {
  const loaded = launchctl('print', `gui/${process.getuid()}/${LABEL}`).status === 0;
  console.log(`Keka URL:        ${config.baseUrl}`);
  console.log(`Times:           ${config.inTime} - ${config.outTime}`);
  console.log(`Note:            ${config.note}`);
  console.log(`No-entry days:   ${config.includeNoEntryDays ? 'included' : 'skipped'}`);
  console.log(`Schedule:        ${loaded ? `ON, day ${config.scheduleDay} at ${config.scheduleTime}` : 'OFF (node keka.js schedule)'}`);
  console.log(`Login saved:     ${fs.existsSync(AUTH_FILE) ? 'yes (if it expired, run: node keka.js login)' : 'no (node keka.js login)'}`);
  console.log(`Days submitted:  ${Object.keys(loadSubmitted()).length}`);
  const latest = fs.existsSync(LOG_DIR) && fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.log')).sort().pop();
  if (latest) {
    console.log(`\nLast lines of logs/${latest}:`);
    console.log(fs.readFileSync(path.join(LOG_DIR, latest), 'utf8').trim().split('\n').slice(-8).join('\n'));
  }
}

// ---------- setup ----------

async function setup() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, def) => new Promise((res) => rl.question(`${q} [${def}]: `, (a) => res(a.trim() || String(def))));
  const askTime = async (q, def) => {
    for (;;) {
      const v = await ask(q, def);
      if (/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return v;
      console.log('  Please use 24-hour HH:MM, e.g. 09:30');
    }
  };
  const askYes = async (q, def) => /^y/i.test(await ask(`${q} (y/n)`, def ? 'y' : 'n'));

  console.log('\nKeka regularise setup. Press Enter to keep the value in [brackets].\n');
  const c = { ...config };
  c.baseUrl = (await ask('Your Keka URL', c.baseUrl)).replace(/\/+$/, '');
  c.inTime = await askTime('Shift start (HH:MM)', c.inTime);
  c.outTime = await askTime('Shift end (HH:MM)', c.outTime);
  c.note = await ask('Note on each request', c.note);
  c.includeNoEntryDays = await askYes('Also regularise days with NO time entries? (say n if those are usually leave)', c.includeNoEntryDays);
  for (;;) {
    c.scheduleDay = Number(await ask('Run on which day of the month (1-28)', c.scheduleDay));
    if (c.scheduleDay >= 1 && c.scheduleDay <= 28) break;
    console.log('  Pick 1-28 so it runs in every month.');
  }
  c.scheduleTime = await askTime('At what time (HH:MM, after your workday)', c.scheduleTime);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2) + '\n');
  config = c;
  console.log('\nSaved config.json.');

  rl.pause();
  if (!(await login())) return rl.close();

  console.log('\nPreview (nothing is submitted):');
  await regularise(false);

  rl.resume();
  if (await askYes('\nSubmit the days listed above now?', false)) await regularise(true);
  if (await askYes(`Turn on the monthly run (day ${c.scheduleDay} at ${c.scheduleTime})?`, true)) schedule();
  rl.close();
  console.log('\nDone. Check anytime with: node keka.js status');
}

const commands = {
  setup,
  login,
  preview: () => regularise(false),
  run: () => regularise(true),
  schedule,
  unschedule,
  status,
  help: () => console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')),
};

if (!commands[command]) {
  console.log(`Unknown command "${command}".`);
  commands.help();
  process.exitCode = 1;
} else {
  Promise.resolve(commands[command]()).catch((e) => {
    log('Error:', e.message);
    process.exitCode = 1;
  });
}
