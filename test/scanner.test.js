// test/scanner.test.js -- run with: node test/scanner.test.js
//
// Uses real responses captured from barbican.org.uk (test/fixtures) for the
// parsing/classification, and hand-built readings for the alert state machine.

const fs = require('fs');
const path = require('path');
const { parseListing, groupByEvent, hasLoadMore } = require('../scanner/parseListing');
const { classifyInstancesResponse } = require('../scanner/barbican');
const { qualify } = require('../scanner/qualify');
const { nextRecord, dueAlerts } = require('../scanner/decide');
const { headerSafe } = require('../notify');
const { londonToUtcMs, formatLondon, headsUpWindow } = require('../scanner/time');
const { parseProductionPage, parseSitemap } = require('../scanner/ntAnnouncements');
const { parsePageOnSaleDates, parseOverlayTime, isRollingPlaceholder, parseNtBookingText } = require('../scanner/dates');
const { classifyEvent, listingFor } = require('../scanner/nationalTheatre');

let failures = 0;
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) {
    console.log('  expected:', JSON.stringify(expected));
    console.log('  actual:  ', JSON.stringify(actual));
  }
}
const fixture = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');

// --- listing parsing -------------------------------------------------------
{
  const html = fixture('barbican-listing-sample.html');
  const cards = parseListing(html);
  check('parseListing: one card per event per day (two events share a day)', cards.length, 4);
  check('parseListing: reads title with entities decoded', cards[0].title, 'Scottish Ensemble: Bach & Blood');
  check('parseListing: reads node id from the saved-event button', cards[0].nodeId, '221871');
  check('parseListing: reads art-form tags', cards[3].tags, ['Classical music', 'Contemporary music']);
  const events = groupByEvent(cards);
  check('groupByEvent: multi-date show collapses to one record', events.size, 3);
  check('groupByEvent: counts the distinct dates a show runs on', events.get('/whats-on/2026/event/pam-tanowitz-dance-pastoral').days, ['Fri 2 Oct', 'Sat 3 Oct']);
  check('hasLoadMore: detects the pager', hasLoadMore(html), true);
  check('hasLoadMore: false when absent', hasLoadMore('<p>no pager</p>'), false);
}

// --- booking-status classification (real captured overlays) ---------------
{
  const bookable = classifyInstancesResponse(fixture('barbican-instances-bookable.json'));
  check('classify: on-sale show reads bookable', bookable.state, 'bookable');
  check('classify: fully sold-out show reads sold_out', classifyInstancesResponse(fixture('barbican-instances-sold-out.json')).state, 'sold_out');

  const gatedNoPerf = classifyInstancesResponse(fixture('barbican-instances-gated-no-performances.json'));
  check('classify: presale overlay with the performance list hidden reads gated (not an error)', gatedNoPerf.state, 'gated');
  check('classify: captures the general-sale time', gatedNoPerf.generalSaleText, '6.21pm, Fri 02 Oct');

  const gatedWithPerf = classifyInstancesResponse(fixture('barbican-instances-gated-with-performances.json'));
  check('classify: presale with performances listed reads gated', gatedWithPerf.state, 'gated');
  check('classify: captures the general-sale time with performances listed', gatedWithPerf.generalSaleText, '10.00am, Fri 09 Oct');

  check('classify: empty body reads not_on_sale', classifyInstancesResponse('').state, 'not_on_sale');
  check(
    'classify: a long unrecognised page is an error, not "not on sale"',
    classifyInstancesResponse('<html>' + 'x'.repeat(400) + '</html>').state,
    'error'
  );
}

// --- qualification -----------------------------------------------------------
const cfg = { watchlist: ['bob dylan'], limitedRunMaxDates: 3, minSignals: 2, confirmReadings: 2 };
{
  const q1 = qualify({ title: 'A Plain Concert', text: '', days: ['d1'], sawGate: false }, cfg);
  check('qualify: one weak signal alone is not enough', q1.qualifies, false);

  const q2 = qualify({ title: 'Plain', text: '', days: ['d1'], sawGate: true }, cfg);
  check('qualify: short run + presale gate qualifies', q2.qualifies, true);
  check('qualify: reasons explain why', q2.reasons, ['short run (1 date)', 'presale / general-sale gate']);

  const q3 = qualify({ title: 'Bob Dylan in concert', text: '', days: ['a', 'b', 'c', 'd', 'e'], sawGate: false }, cfg);
  check('qualify: a watchlist hit qualifies on its own', q3.qualifies, true);

  const q4 = qualify({ title: 'Opera (UK premiere)', text: '', days: ['d1'], sawGate: false }, cfg);
  check('qualify: short run + premiere qualifies', q4.qualifies, true);

  const q5 = qualify({ title: 'Long run', text: '', days: ['1', '2', '3', '4', '5'], sawGate: true }, cfg);
  check('qualify: long run + presale only is one signal, not enough', q5.qualifies, false);
}

// --- alert-once state machine ------------------------------------------------
const listing = { key: '/whats-on/2026/event/x', venue: 'Barbican', url: 'https://www.barbican.org.uk/whats-on/2026/event/x', venueSignals: [], nodeId: '1', title: 'X', tags: [], text: '', days: ['d1'] };
const ctx = (over = {}) => ({
  now: '2026-10-02T18:00:00.000Z',
  baselineRun: false,
  config: cfg,
  listing,
  qualifyFn: (rec) => qualify(rec, cfg),
  ...over,
});
{
  // Baseline: a waiting show is recorded, never alerted.
  let r = nextRecord(null, { state: 'gated' }, ctx({ baselineRun: true }));
  check('baseline: gated show recorded, no alert', r.alert, false);
  check('baseline: marks the show as waiting', r.record.wasWaiting, true);
  check('baseline: remembers the presale gate for qualification', r.record.sawGate, true);

  // First bookable reading: needs confirmation (transient-error protection).
  let r2 = nextRecord(r.record, { state: 'bookable' }, ctx());
  check('waiting -> bookable: first reading does NOT alert yet', r2.alert, false);
  check('waiting -> bookable: streak is 1', r2.record.bookableStreak, 1);

  // Second consecutive bookable reading: alert.
  let r3 = nextRecord(r2.record, { state: 'bookable' }, ctx());
  check('waiting -> bookable: second consecutive reading alerts', r3.alert, true);
  check('alert: alertedAt recorded', typeof r3.record.alertedAt, 'string');

  // Never again.
  let r4 = nextRecord(r3.record, { state: 'bookable' }, ctx());
  check('alert once: a later bookable reading does not alert again', r4.alert, false);
  let r5 = nextRecord(nextRecord(r4.record, { state: 'sold_out' }, ctx()).record, { state: 'bookable' }, ctx());
  check('alert once: sold out then back on sale does not alert again', r5.alert, false);

  // A blip back to waiting resets the streak, so a flicker cannot alert.
  let b1 = nextRecord(r.record, { state: 'bookable' }, ctx());
  let b2 = nextRecord(b1.record, { state: 'not_on_sale' }, ctx());
  let b3 = nextRecord(b2.record, { state: 'bookable' }, ctx());
  check('flicker: bookable, waiting, bookable does not alert', b3.alert, false);

  // Errors are not evidence: they neither alert nor reset the streak.
  let e1 = nextRecord(b1.record, { state: 'error', error: 'HTTP 503' }, ctx());
  check('error reading: no alert', e1.alert, false);
  check('error reading: previous state kept', e1.record.state, 'bookable');
  check('error reading: streak kept', e1.record.bookableStreak, 1);
  let e2 = nextRecord(e1.record, { state: 'bookable' }, ctx());
  check('error between readings: confirmation still completes', e2.alert, true);

  // Outage guard: a live show reported "not on sale" is ignored.
  const live = nextRecord(null, { state: 'bookable' }, ctx({ baselineRun: true })).record;
  const outage = nextRecord(live, { state: 'not_on_sale' }, ctx());
  check('outage guard: live show reading not_on_sale is treated as an error', outage.record.state, 'bookable');
  check('outage guard: and does not mark it waiting', outage.record.wasWaiting, false);
  const recovered = nextRecord(nextRecord(outage.record, { state: 'bookable' }, ctx()).record, { state: 'bookable' }, ctx());
  check('outage guard: recovery after an outage never alerts', recovered.alert, false);

  // A show that was sold out and returns is the main watcher's job.
  const so = nextRecord(null, { state: 'sold_out' }, ctx({ baselineRun: true })).record;
  const back = nextRecord(nextRecord(so, { state: 'bookable' }, ctx()).record, { state: 'bookable' }, ctx());
  check('sold_out -> bookable is not a scanner alert', back.alert, false);

  // Brand-new show, already bookable on first sight after the baseline.
  const fresh = nextRecord(null, { state: 'bookable' }, ctx({ listing: { ...listing, title: 'Opera (UK premiere)' } }));
  check('surprise drop: a show already on sale at first sight is ignored', fresh.alert, false);
  const freshLater = nextRecord(nextRecord(fresh.record, { state: 'bookable' }, ctx()).record, { state: 'bookable' }, ctx());
  check('surprise drop: still silent on later checks', freshLater.alert, false);
  const freshBoring = nextRecord(null, { state: 'bookable' }, ctx({ listing: { ...listing, days: ['1', '2', '3', '4', '5', '6'] } }));
  check('new non-qualifying show already on sale does not alert', freshBoring.alert, false);

  // Waiting show that does not qualify never alerts.
  const dull = { ...listing, days: ['1', '2', '3', '4', '5'] };
  let d1 = nextRecord(null, { state: 'not_on_sale' }, ctx({ baselineRun: true, listing: dull }));
  let d2 = nextRecord(nextRecord(d1.record, { state: 'bookable' }, ctx({ listing: dull })).record, { state: 'bookable' }, ctx({ listing: dull }));
  check('non-qualifying show going on sale does not alert', d2.alert, false);
}


// --- National Theatre -------------------------------------------------------
{
  const bookable = JSON.parse(fixture('nt-event-some-woman.json'));
  const soldOut = JSON.parse(fixture('nt-event-electra.json'));
  check('NT classify: event with public (mos 11) availability reads bookable', classifyEvent(bookable).state, 'bookable');
  check('NT classify: reports the cheapest public price', typeof classifyEvent(bookable).publicFrom, 'number');
  check('NT classify: public rows all 0% reads sold_out (patron-access scraps ignored)', classifyEvent(soldOut).state, 'sold_out');
  check('NT classify: no performances yet reads not_on_sale', classifyEvent({ _id: '1', title: 'X', instances: [] }).state, 'not_on_sale');

  // Synthetic (derived from the real sold-out fixture): promo / access
  // allocations must never make a running, sold-out show look upcoming.
  // (Real case: Some Woman keeps a standing mode-124 allocation above 10%.)
  const promo = JSON.parse(fixture('nt-event-electra.json'));
  promo.instances.forEach((i) => i.prices.forEach((p) => { if (p.mos !== '11') p.percentage = '40%'; }));
  check('NT classify (synthetic): non-public availability alone still reads sold_out', classifyEvent(promo).state, 'sold_out');

  const noPublic = JSON.parse(fixture('nt-event-electra.json'));
  noPublic.instances.forEach((i) => { i.prices = i.prices.filter((p) => p.mos !== '11'); });
  check('NT classify (synthetic): performances with no public sale rows yet read gated', classifyEvent(noPublic).state, 'gated');

  const l = listingFor(bookable);
  check('NT listing: key is stable and namespaced', l.key, 'nt-95884');
  check('NT listing: venue', l.venue, 'National Theatre');
  check('NT listing: counts distinct performance dates', l.days.length, 3);
  check('NT listing: Dorfman earns a venue signal', l.venueSignals, ['Dorfman Theatre (smallest auditorium)']);
  check('NT listing: carries a precomputed reading (no second request needed)', l.reading.state, 'bookable');

  const ntCfg = { ...cfg, limitedRunByVenue: { 'National Theatre': 0 } };
  const longRun = { venue: 'National Theatre', title: 'Big Show', text: '', days: Array.from({ length: 40 }, (_, i) => String(i)), sawGate: false, venueSignals: [] };
  check('NT qualify: a long run is never a "short run" signal', qualify({ ...longRun, sawGate: true }, ntCfg).qualifies, false);
  check(
    'NT qualify: Dorfman + presale gate qualifies',
    qualify({ ...longRun, sawGate: true, venueSignals: ['Dorfman Theatre (smallest auditorium)'] }, ntCfg).qualifies,
    true
  );
}

// --- a new announcement counts as waiting even if it first reads sold out --
{
  const first = nextRecord(null, { state: 'sold_out' }, ctx({ listing: { ...listing, days: ['1'] , venueSignals: ['Dorfman Theatre (smallest auditorium)'] } }));
  check('new announcement first seen sold out is treated as waiting', first.record.wasWaiting, true);
  const l2 = { ...listing, venueSignals: ['Dorfman Theatre (smallest auditorium)'] };
  const a = nextRecord(first.record, { state: 'bookable' }, ctx({ listing: l2 }));
  const b = nextRecord(a.record, { state: 'bookable' }, ctx({ listing: l2 }));
  check('...and alerts when it then opens to the public (confirmed)', b.alert, true);
}


// --- London time / dates -------------------------------------------------------
{
  const iso = (ms) => new Date(ms).toISOString();
  check('londonToUtc: BST (summer) is UTC+1', iso(londonToUtcMs(2026, 9, 9, 10, 0)), '2026-10-09T09:00:00.000Z');
  check('londonToUtc: GMT (after 25 Oct 2026) is UTC+0', iso(londonToUtcMs(2026, 10, 3, 10, 0)), '2026-11-03T10:00:00.000Z');
  check('londonToUtc: clock change on 28 Mar 2027 handled', iso(londonToUtcMs(2027, 2, 29, 10, 0)), '2027-03-29T09:00:00.000Z');
  check('formatLondon: day and time', formatLondon(londonToUtcMs(2026, 9, 9, 10, 0)), 'Fri 9 Oct, 10am');
  check('formatLondon: minutes shown when non-zero', formatLondon(londonToUtcMs(2026, 9, 9, 18, 30)), 'Fri 9 Oct, 6.30pm');

  const now = londonToUtcMs(2026, 9, 2, 18, 0);
  // Real wording from barbican.org.uk/whats-on/2027/event/marcel-khalife
  const page = parsePageOnSaleDates('Presented by Marsm TICKETS GO ON SALE TO MEMBERS - WED 7 OCT TICKETS GO ON SALE TO PUBLIC - FRI 9 OCT Show more', now);
  check('page copy: public sale date', page.public, { y: 2026, m0: 9, d: 9 });
  check('page copy: members presale date', page.members, { y: 2026, m0: 9, d: 7 });
  check('page copy: no wording gives nothing', parsePageOnSaleDates('A lovely evening of music.', now), { members: null, public: null });
  check('page copy: a date without a year rolls to next year when past', parsePageOnSaleDates('GO ON SALE TO PUBLIC - FRI 9 JAN', now).public.y, 2027);

  check('overlay time: parsed as London time', iso(parseOverlayTime('10.00am, Fri 09 Oct', now).ms), '2026-10-09T09:00:00.000Z');
  check('overlay time: pm times', iso(parseOverlayTime('6.55pm, Fri 02 Oct', now).ms), '2026-10-02T17:55:00.000Z');
  check('overlay time: unparseable text gives null', parseOverlayTime('Booking available', now), null);

  // Seen live: the jazz festival shows' "general sale from" time kept sliding
  // forward (6.21pm -> 6.26pm -> 6.55pm) across scans on the same evening.
  const rollingNow = Date.parse('2026-10-02T17:50:00Z');
  check('rolling placeholder: a time a few minutes ahead is ignored', isRollingPlaceholder(Date.parse('2026-10-02T17:55:00Z'), rollingNow), true);
  check('rolling placeholder: a fixed time next week is real', isRollingPlaceholder(Date.parse('2026-10-09T09:00:00Z'), rollingNow), false);

  // Real wording from nationaltheatre.org.uk/productions/west-side-story
  const nt = parseNtBookingText('From November 2027 Booking opens in November 2026 To be notified when tickets go on sale: Sign up', now);
  check('NT booking text: month precision', [nt.precision, nt.label], ['month', 'November 2026']);
  const exact = parseNtBookingText('Booking opens Tuesday 3 November 2026 at 10am', now); // synthetic: exact wording not yet seen live
  check('NT booking text (synthetic): exact date and time', [exact.precision, iso(exact.ms)], ['exact', '2026-11-03T10:00:00.000Z']);
  // Real wording from the Ballet Shoes UK-tour page (a Norwich venue's own date).
  const tour = parseNtBookingText('Norwich Theatre Royal Public booking opens 25 September Anton Du Beke is not scheduled', now);
  check('NT booking text: "Public booking opens 25 September" reads as a date (year inferred forward)', [tour.precision, new Date(tour.ms).toISOString().slice(0, 10)], ['date', '2027-09-25']);
  check('NT booking text: nothing to read gives null', parseNtBookingText('Book tickets for Othello', now), null);

  const open = { at: '2026-10-09T09:00:00.000Z', precision: 'exact' };
  const w = headsUpWindow(open, 2);
  check('heads-up: 2h before a 10am opening is 8am London', [iso(w.from), iso(w.until)], ['2026-10-09T07:00:00.000Z', '2026-10-09T09:00:00.000Z']);
  const early = headsUpWindow({ at: iso(londonToUtcMs(2026, 9, 9, 8, 30)), precision: 'exact' }, 2);
  check('heads-up: never earlier than 7am London on the day', iso(early.from), '2026-10-09T06:00:00.000Z');
  const evening = headsUpWindow({ at: iso(londonToUtcMs(2026, 9, 9, 18, 0)), precision: 'exact' }, 2);
  check('heads-up: an evening opening gets 2h notice', iso(evening.from), '2026-10-09T15:00:00.000Z');
  const dateOnly = headsUpWindow({ at: iso(londonToUtcMs(2026, 9, 9, 10, 0)), precision: 'date' }, 2);
  check('heads-up: date-only opening fires at 8am London that day', iso(dateOnly.from), '2026-10-09T07:00:00.000Z');
}


// --- announcements, heads-ups and your tick / untick ------------------------
{
  const cfg2 = { ...cfg, headsUpHoursBefore: 2 };
  const ctx2 = (over = {}) => ({ ...ctx(over), config: cfg2 });
  const D = (s) => Date.parse(s);
  const flaggedListing = { ...listing, venueSignals: ['Dorfman Theatre (smallest auditorium)'], days: ['1'] };

  // Announcement: a new, flagged, not-yet-on-sale show after the baseline.
  const ann = nextRecord(null, { state: 'gated' }, ctx2({ listing: flaggedListing }));
  check('announcement: new waiting show after baseline is marked as an announcement', ann.record.isAnnouncement, true);
  check('announcement: flagged show is due an announcement alert', dueAlerts(ann.record, D('2026-10-02T18:00:00Z'), cfg2, false), ['announced']);
  check('announcement: nothing is due during a baseline run', dueAlerts(ann.record, D('2026-10-02T18:00:00Z'), cfg2, true), []);
  check('announcement: only once', dueAlerts({ ...ann.record, announcedAlertedAt: '2026-10-02T18:00:00Z' }, D('2026-10-02T18:05:00Z'), cfg2, false), []);
  const dull = nextRecord(null, { state: 'not_on_sale' }, ctx2({ listing: { ...listing, days: ['1', '2', '3', '4', '5', '6'] } }));
  check('announcement: an unflagged show is not announced', dueAlerts(dull.record, D('2026-10-02T18:00:00Z'), cfg2, false), []);
  const baselineShow = nextRecord(null, { state: 'not_on_sale' }, ctx2({ baselineRun: true, listing: flaggedListing }));
  check('announcement: shows present at baseline are never announced', baselineShow.record.isAnnouncement, false);
  const manual = nextRecord(null, { state: 'not_on_sale' }, ctx2({ listing: { ...flaggedListing, manual: true } }));
  check('announcement: a manually added show is not "announced" to you', manual.record.isAnnouncement, false);

  // Heads-up: exact opening time 10am London Fri 9 Oct = 09:00Z, fires from 07:00Z.
  const opens = { at: '2026-10-09T09:00:00.000Z', precision: 'exact' };
  const waiting = nextRecord(null, { state: 'not_on_sale', opens }, ctx2({ baselineRun: true, listing: flaggedListing })).record;
  const eligibleWaiting = { ...waiting, eligible: true };
  check('heads-up: too early', dueAlerts(eligibleWaiting, D('2026-10-09T06:59:00Z'), cfg2, false), []);
  check('heads-up: due 2h before opening', dueAlerts(eligibleWaiting, D('2026-10-09T07:05:00Z'), cfg2, false), ['headsUp']);
  check('heads-up: still due a minute before opening', dueAlerts(eligibleWaiting, D('2026-10-09T08:59:00Z'), cfg2, false), ['headsUp']);
  check('heads-up: pointless once it has opened', dueAlerts(eligibleWaiting, D('2026-10-09T09:30:00Z'), cfg2, false), []);
  check('heads-up: only once', dueAlerts({ ...eligibleWaiting, headsUpAt: 'x' }, D('2026-10-09T07:05:00Z'), cfg2, false), []);
  check('heads-up: an unflagged show gets none', dueAlerts({ ...waiting, eligible: false }, D('2026-10-09T07:05:00Z'), cfg2, false), []);
  const monthOnly = { ...eligibleWaiting, opens: { at: '2026-11-01T00:00:00.000Z', precision: 'month', label: 'November 2026' } };
  check('heads-up: month-only dates (National Theatre) never fire one', dueAlerts(monthOnly, D('2026-11-01T08:00:00Z'), cfg2, false), []);
  const dateOnly = { ...eligibleWaiting, opens: { at: '2026-10-09T09:00:00.000Z', precision: 'date' } };
  check('heads-up: date-only fires from 8am London that day', dueAlerts(dateOnly, D('2026-10-09T07:10:00Z'), cfg2, false), ['headsUp']);

  // Tick / untick overrides.
  const plain = { ...listing, days: ['1', '2', '3', '4', '5', '6'] }; // does not qualify on its own
  const waitPlain = nextRecord(null, { state: 'not_on_sale' }, ctx2({ baselineRun: true, listing: plain, selection: 'on' }));
  const open1 = nextRecord(waitPlain.record, { state: 'bookable' }, ctx2({ listing: plain, selection: 'on' }));
  const open2 = nextRecord(open1.record, { state: 'bookable' }, ctx2({ listing: plain, selection: 'on' }));
  check('ticked: an unflagged show you ticked alerts when it opens', open2.alert, true);

  const waitFlagged = nextRecord(null, { state: 'gated' }, ctx2({ baselineRun: true, listing: flaggedListing, selection: 'off' }));
  const f1 = nextRecord(waitFlagged.record, { state: 'bookable' }, ctx2({ listing: flaggedListing, selection: 'off' }));
  const f2 = nextRecord(f1.record, { state: 'bookable' }, ctx2({ listing: flaggedListing, selection: 'off' }));
  check('unticked: a flagged show you unticked stays silent when it opens', f2.alert, false);
  check('unticked: and gets no announcement either', dueAlerts(nextRecord(null, { state: 'gated' }, ctx2({ listing: flaggedListing, selection: 'off' })).record, D('2026-10-02T18:00:00Z'), cfg2, false), []);
}

// --- National Theatre announcements (real captured pages) ----------------
{
  const now2 = Date.parse('2026-10-02T18:00:00Z');
  const items = parseSitemap(fixture('nt-season-sitemap.xml'));
  check('sitemap: reads production slugs', items.map((i) => i.slug), ['othello', 'jack-absolute-flies-again', 'the-crucible', 'west-side-story']);
  check('sitemap: reads lastmod', items[0].lastmod, '2025-11-18T11:57:49+00:00');

  const wss = parseProductionPage(fixture('nt-production-west-side-story.html'), now2);
  check('production page: title is cleaned', wss.title, 'West Side Story');
  check('production page: announced show is upcoming', wss.upcoming, true);
  check('production page: month-level opening', [wss.opens.precision, wss.opens.label], ['month', 'November 2026']);
  check('production page: keeps the description so watchlist names can match', /Broadway classic/.test(wss.blurb), true);
  check('production page: a page with no booking wording is not upcoming', parseProductionPage('<title>Othello Tickets | Play</title><body>Book tickets for Othello. Show finished.</body>', now2).upcoming, false);
  check('production page: tour titles keep their raw title for filtering', parseProductionPage('<title>Ballet Shoes | UK Tour | Family shows | National Theatre</title><body>x</body>', now2).rawTitle.includes('UK Tour'), true);
  check('production page: tour title cleaned', parseProductionPage('<title>Ballet Shoes | UK Tour | Family shows | National Theatre</title><body>x</body>', now2).title, 'Ballet Shoes');
}

// --- returns: sold-out dates getting tickets back (ticked shows only) ---------
{
  const { alertMessage } = require('../scanner/messages');
  const cfg3 = { ...cfg, headsUpHoursBefore: 2 };
  const ctx3 = (over = {}) => ({ ...ctx(over), config: cfg3, selection: 'on' });
  const perfs = (a, b, c) => [
    { key: 'd1', label: '9 Oct 2026, 7.30pm', available: a, price: 30 },
    { key: 'd2', label: '10 Oct 2026, 7.30pm', available: b, price: 45 },
    { key: 'd3', label: '11 Oct 2026, 7.30pm', available: c, price: null },
  ];
  const rd = (state, performances) => ({ state, performances });

  // First reading after ticking is a silent baseline.
  const first = nextRecord(null, rd('sold_out', perfs(false, false, false)), ctx3({ baselineRun: true }));
  check('returns: nothing is reported on the first reading (baseline)', first.returns, []);
  check('returns: per-date state is remembered for a ticked show', first.record.perf, { d1: 'sold_out', d2: 'sold_out', d3: 'sold_out' });

  // A sold-out date opens up.
  const flip = nextRecord(first.record, rd('bookable', perfs(false, true, false)), ctx3());
  check('returns: a sold-out date that now has tickets is reported', flip.returns.map((p) => p.key), ['d2']);
  check('returns: it is recorded as available afterwards', flip.record.perf.d2, 'available');

  // No repeat while it stays available.
  const again = nextRecord(flip.record, rd('bookable', perfs(false, true, false)), ctx3());
  check('returns: a date that stays available is not reported again', again.returns, []);

  // Sells out then comes back: reported again.
  const gone = nextRecord(again.record, rd('sold_out', perfs(false, false, false)), ctx3());
  const back = nextRecord(gone.record, rd('bookable', perfs(false, true, false)), ctx3());
  check('returns: sells out and returns again is reported again', back.returns.map((p) => p.key), ['d2']);

  // A brand-new date appears on sale.
  const newDate = nextRecord(back.record, rd('bookable', [...perfs(false, true, false), { key: 'd4', label: '12 Oct 2026, 7.30pm', available: true }]), ctx3());
  check('returns: a brand-new date on sale is reported', newDate.returns.map((p) => p.key), ['d4']);

  // Shows you have not ticked are never tracked.
  const unticked = nextRecord(first.record, rd('bookable', perfs(false, true, false)), { ...ctx3(), selection: 'auto' });
  check('returns: an unticked show reports nothing', unticked.returns, []);
  check('returns: and its per-date memory is dropped', 'perf' in unticked.record, false);

  // Waiting -> open is the "on sale now" alert's job, not a return.
  const waiting = nextRecord(null, rd('not_on_sale', []), ctx3({ baselineRun: true }));
  const opens = nextRecord(waiting.record, rd('bookable', perfs(true, true, true)), ctx3());
  check('returns: a show opening for the first time is not a "return"', opens.returns, []);

  // A show that was never tracked before being ticked while live: baseline first.
  const live = nextRecord(null, rd('bookable', perfs(true, false, false)), ctx3({ baselineRun: true }));
  const tickedLater = nextRecord({ ...live.record, perf: undefined }, rd('bookable', perfs(true, true, false)), ctx3());
  check('returns: ticking a live show starts from a silent baseline', tickedLater.returns, []);

  // Wording.
  const rec = { venue: 'National Theatre', title: 'Some Woman', reasons: [], selection: 'on' };
  const msg = alertMessage('returns', rec, { performances: [{ label: '9 Oct 2026, 7.30pm', price: 51 }, { label: '10 Oct 2026, 7.30pm', price: 45 }] });
  check('returns message: title', msg.title, 'Tickets back: Some Woman');
  check('returns message: lists the dates, the cheapest price and why', msg.message.split('\n'), ['National Theatre · 2 dates with tickets: 9 Oct 2026, 7.30pm, 10 Oct 2026, 7.30pm', 'From £45', 'You ticked this show']);
  const many = alertMessage('returns', rec, { performances: Array.from({ length: 6 }, (_, i) => ({ label: `${i + 1} Nov` })) });
  check('returns message: long lists are shortened', /and 2 more/.test(many.message), true);
}

// --- header safety (a title like "Esmé" must not crash the ntfy POST) -----
{
  check('headerSafe: plain ASCII is untouched', headerSafe('Barbican on sale: Jazz'), 'Barbican on sale: Jazz');
  check(
    'headerSafe: non-ASCII becomes an RFC 2047 encoded word',
    headerSafe('Barbican on sale: Esmé'),
    '=?UTF-8?B?' + Buffer.from('Barbican on sale: Esmé', 'utf8').toString('base64') + '?='
  );
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll scanner tests passed.');
}
