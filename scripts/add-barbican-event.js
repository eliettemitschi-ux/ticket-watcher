#!/usr/bin/env node
// scripts/add-barbican-event.js
//
// Self-service "add a Barbican event by URL" -- used by the
// add-barbican-event.yml GitHub Actions workflow (a manually-triggered
// "Run workflow" form on github.com), so adding a new Barbican show
// doesn't need anyone to dig through DevTools for its node id the way
// every OTHER venue in this project needed reverse-engineering by hand.
// Barbican happens to embed its own node id in every event page's raw
// HTML (in a Drupal settings blob: `"currentPath":"node\/<id>"`) --
// confirmed reliable, via plain HTTP with no browser needed, across
// every Barbican event added to this project so far.
//
// Other venues (Almeida, Southbank Centre, National Theatre, ...) each
// needed their own bespoke reverse-engineering the first time -- that's
// still true here, this script only handles Barbican.
//
// Usage: node scripts/add-barbican-event.js <event-url> [display name]

require('dotenv').config();
const fetch = require('node-fetch');
const store = require('../store');
const { checkHtmlInstances } = require('../checkers/htmlInstancesChecker');

const CURRENT_PATH_RE = /"currentPath":"node\\\/(\d+)"/;

async function main() {
  const url = process.argv[2];
  let name = process.argv.slice(3).join(' ').trim();

  if (!url) {
    console.error('Usage: node scripts/add-barbican-event.js <event-url> [display name]');
    process.exit(1);
  }
  if (!/^https:\/\/(www\.)?barbican\.org\.uk\//.test(url)) {
    console.error(`This script only knows how to auto-discover Barbican events. "${url}" doesn't look like a barbican.org.uk URL.`);
    process.exit(1);
  }

  console.log(`Fetching ${url} ...`);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ticket-watcher/1.0; personal availability checker)' },
  });
  if (!res.ok) {
    console.error(`HTTP ${res.status} fetching the event page.`);
    process.exit(1);
  }
  const html = await res.text();

  const match = html.match(CURRENT_PATH_RE);
  if (!match) {
    console.error('Could not find this page\'s node id (the "currentPath" marker) -- the page structure may have changed.');
    process.exit(1);
  }
  const nodeId = match[1];
  console.log(`Found node id: ${nodeId}`);

  if (!name) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    name = titleMatch ? titleMatch[1].replace(/\s*\|\s*Barbican\s*$/i, '').trim() : `Barbican event ${nodeId}`;
    console.log(`No name given -- using the page's own title: "${name}"`);
  }

  const instancesUrl = `https://www.barbican.org.uk/node/${nodeId}/instances`;
  console.log(`Verifying via ${instancesUrl} ...`);
  const recipe = { mode: 'html-instances', venue: 'barbican', instancesUrl };
  const result = await checkHtmlInstances(recipe);
  if (!Array.isArray(result)) {
    console.error(`Verification failed: ${result.error}`);
    process.exit(1);
  }
  console.log(`Verified -- found ${result.length} performance(s):`);
  result.forEach((p) => console.log(`  ${p.label}: ${p.state}`));

  const existing = store.listEvents().find((e) => e.recipe?.instancesUrl === instancesUrl);
  if (existing) {
    console.log(`Already watching this event as "${existing.name}" (id ${existing.id}) -- not adding a duplicate.`);
    return;
  }

  const event = store.addEvent({ name, venue: 'Barbican', url, recipe, timeFilter: null });
  store.updatePerformances(event.id, result);
  console.log(`Added "${name}" (id ${event.id}).`);
}

main().catch((err) => {
  console.error('add-barbican-event.js crashed:', err);
  process.exit(1);
});
