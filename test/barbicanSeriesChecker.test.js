// parseUpcoming reads only the Upcoming tab of a Barbican series page.
const assert = require('assert');
const { parseUpcoming } = require('../checkers/barbicanSeriesChecker');

const card = (href, title, date) => `<article class="listing--event"><div class="search-listing"><a class="search-listing__link" href="${href}" rel="bookmark"></a><div class="listing-title-wrapper"><h2 class="listing-title listing-title--event">${title}</h2></div><p class="listing-date"><strong><time datetime="2026-11-28T16:00:00Z">${date}</time></strong></p></div></article>`;

const html =
  `<div data-tab-title="Upcoming">${card('/whats-on/2026/event/a', 'Film A + ScreenTalk', 'Sat 28 Nov 2026, 16:00')}${card('/index%2Ephp/whats-on/2026/event/b', 'Dune &amp; the &#039;Sea&#039;', 'Thu 10 Dec 2026, 18:30')}</div>` +
  `<div data-tab-title="Archive">${card('/whats-on/2025/event/old', 'Old ScreenTalk', 'Mon 1 Jan 2025')}</div>` +
  `<div data-tab-title="Access"></div>`;

const events = parseUpcoming(html);
assert.deepStrictEqual(events.map((e) => e.title), ['Film A + ScreenTalk', "Dune & the 'Sea'"]);
assert.strictEqual(events[0].date, 'Sat 28 Nov 2026, 16:00');
assert.strictEqual(events[1].href, '/whats-on/2026/event/b'); // the /index.php prefix is dropped
assert.deepStrictEqual(parseUpcoming('<html>no tabs</html>'), []);

console.log('All Barbican series parser tests passed.');
