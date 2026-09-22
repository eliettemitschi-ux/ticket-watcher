#!/usr/bin/env node
// check.js -- for running the check as a separate, short-lived process
// (Windows Task Scheduler, cron, etc.) INSTEAD of the automatic checking
// server.js now does on its own -- see server.js if you just want the
// dashboard to check itself with nothing else to set up.
//
//   */10 * * * * cd /path/to/ticket-watcher && node check.js >> check.log 2>&1
//
// Walks every event in data/events.json, checks its current status (via
// the fast API recipe if one was discovered, otherwise a real headless
// page load), and fires a notification the moment a performance flips
// from anything else into "available". Deliberately a short-lived
// process when run this way -- a fresh run each time rather than a
// long-lived loop, so a Chromium leak or a hung page from one bad run
// can't slowly eat memory over weeks.

require('dotenv').config();
const { runAllChecks } = require('./runChecks');

runAllChecks().catch((err) => {
  console.error('check.js crashed:', err);
  process.exit(1);
});
