#!/usr/bin/env node
// discover.js -- command-line helper to add a new event by URL.
//
//   node discover.js <url> "<name>" ["<venue>"] ["<timeFilter>"]
//
// timeFilter is optional -- for a show with more than one date/time,
// e.g. "8.30pm", only that performance will ever trigger a notification
// (every performance is still checked and shown on the dashboard either
// way). Leave it blank ("") to be notified about any date/time.
//
// Loads the page once with a real (headless) browser, tries to find a
// cheap JSON endpoint to poll going forward, and saves the event (with
// whichever recipe it landed on) into data/events.json. You can also do
// this from the dashboard's "Add event" form -- this script is the same
// logic for when you'd rather script it (e.g. adding several at once).

require('dotenv').config();
const { chromium } = require('playwright');
const { launchBrowser } = require('./browser');
const store = require('./store');
const { checkEvent } = require('./checkers');
const { discoverRecipe } = require('./checkers/discover');

async function main() {
  const [url, name, venue, timeFilter] = process.argv.slice(2);
  if (!url) {
    console.error('Usage: node discover.js <url> "<event name>" ["<venue>"] ["<timeFilter>"]');
    process.exit(1);
  }

  console.log(`Loading ${url} ...`);
  const browser = await launchBrowser(chromium);
  try {
    const { recipe, debug } = await discoverRecipe(url, browser);
    console.log('Discovery result:', JSON.stringify({ recipe, debug }, null, 2));

    const event = store.addEvent({
      name: name || url,
      venue: venue || null,
      url,
      recipe,
      timeFilter: timeFilter || null,
    });

    console.log(`\nAdded "${event.name}" (id ${event.id}).`);
    console.log(
      recipe.mode === 'api'
        ? `Using the fast API check going forward (found ${recipe.apiUrl}).`
        : `Using the full page-render check going forward (no clean API endpoint found -- that's fine, just a bit slower per check).`
    );

    // Run a real check now, using parseMultiText's per-date/per-time
    // breakdown, rather than just trusting discoverRecipe's one-shot read.
    const result = await checkEvent(event, { browser });
    if (result.state === 'error') {
      store.recordCheckError(event.id, result.error);
      console.log(`Could not check current availability: ${result.error}`);
    } else {
      const { event: updated } = store.updatePerformances(event.id, result);
      console.log(`Current status: ${updated.status.state}`);
      if (updated.performances.length > 1) {
        console.log('Performances found:');
        for (const p of updated.performances) console.log(`  - ${p.label}: ${p.state}`);
      }
      if (timeFilter) console.log(`Only notifying for performances matching: "${timeFilter}"`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
