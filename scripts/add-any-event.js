#!/usr/bin/env node
// scripts/add-any-event.js
//
// Self-service "add any event, best effort" -- the SAME auto-discovery
// the live dashboard's own "Add event" form already uses
// (checkers/discover.js), just reachable via a GitHub Actions
// "Run workflow" form instead of a web form. Works reasonably well for
// many sites out of the box (it watches the page's own network traffic
// for something that looks like a real availability API, and only
// keeps that guess if it agrees with what the page's own rendered text
// says); for a genuinely tricky site it falls back to the
// always-works-but-less-precise render mode, same as it always has.
// This is not a smarter version of discovery than what the project
// already had -- just that same capability made reachable without a
// live server.
//
// Usage: node scripts/add-any-event.js <event-url> <display name> [venue] [timeFilter]

require('dotenv').config();
const { chromium } = require('playwright');
const { launchBrowser } = require('../browser');
const { discoverRecipe } = require('../checkers/discover');
const { checkEvent } = require('../checkers');
const store = require('../store');

async function main() {
  const [url, name, venue, timeFilter] = process.argv.slice(2);
  if (!url || !name) {
    console.error('Usage: node scripts/add-any-event.js <event-url> <display name> [venue] [timeFilter]');
    process.exit(1);
  }

  console.log(`Loading ${url} and looking for a real API this page's own widget calls...`);
  const browser = await launchBrowser(chromium);
  try {
    const { recipe, currentState, debug } = await discoverRecipe(url, browser);
    console.log(`Discovery result: recipe mode = "${recipe.mode}", page currently reads as "${currentState}".`);
    console.log('Debug info:', JSON.stringify(debug));

    const event = store.addEvent({ name, venue: venue || null, url, recipe, timeFilter: timeFilter || null });

    console.log('Running a real check to confirm and get the current status...');
    const result = await checkEvent(event, { browser });
    if (result.state === 'error') {
      console.warn(`First check failed: ${result.error} -- the event is still added, it'll retry on the next scheduled run.`);
      store.recordCheckError(event.id, result.error);
    } else {
      store.updatePerformances(event.id, result);
      console.log(`Added "${name}" (id ${event.id}), ${result.length} performance(s) found:`);
      result.forEach((p) => console.log(`  ${p.label}: ${p.state}`));
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('add-any-event.js crashed:', err);
  process.exit(1);
});
