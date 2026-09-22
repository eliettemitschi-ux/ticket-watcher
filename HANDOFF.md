# Ticket Watcher — handoff context

Paste this into a new Claude Code session opened on this same folder
(`D:\codingwizard\Barbican magic`). Every file mentioned below is already
saved there — nothing needs to be re-copied in.

## What this is

A personal Node.js tool that watches sold-out event pages and sends
push (ntfy) / email alerts when tickets open up. Currently watching:

- Haruki Murakami's Jazz at Peter Cat — Barbican
- Golden Boy — Almeida Theatre
- Bob Dylan — Southbank Centre
- Conservatory Sunday — Barbican (added 2026-09-21, id `67247b68`,
  `html-instances`/`barbican` recipe, node id `226604`. 4 showtimes,
  29 Nov 2026, all currently sold out.)
- Anyone Can Dance w/ Beirut Groove Collective — Barbican (added
  2026-09-22, id `d11bef2c`, `html-instances`/`barbican` recipe, node id
  `222399`. One showtime, 7 Nov 2026 11pm, currently sold out.)

Both of the two "REAL TEST" events added on 2026-09-20 (Electra/Persona
at the National Theatre, and Godzilla 2000: Millennium + Introduction at
the Barbican) have now been **removed by the user** — they did their
job (each caught a real live bug, see the "Fixed" entries below) and
the user confirmed they were never actually interested in either show.
Don't re-add either without being asked. Note for next time a
render-mode-only (no dedicated API/html-instances checker) test event
is used this way: Electra/Persona's render-mode parsing kept "flapping"
— repeatedly flagging different specific performances as newly
available across consecutive checks, sending several notifications
naming different dates in quick succession. The date-attribution bug
that explained the WORST of this got fixed (see below), but some
residual noise remained even after that fix; worth watching for if a
similar event is ever added again.

## Current state (working)

- Dashboard: `node server.js`, served at `localhost:3000`, kept alive
  permanently via **pm2** (process name `ticket-watcher`).
  `pm2-windows-startup` is installed so it survives reboots.
- Automatic checking is built into `server.js` itself via `setInterval`
  — no separate scheduler needed. Interval is `POLL_INTERVAL_MINUTES`
  in `.env` (currently **5**, lowered from 10 on 2026-09-21 at the
  user's request for faster detection). Deliberately not lower than
  that: two events (Bob Dylan, and any future render-mode-only event)
  need a real browser per check, and this machine is memory-constrained
  enough (see below) that checking much more often risks reintroducing
  Chromium crashes. Live countdown on the dashboard.
- **Known risk, not yet hardened: `store.js` has no file locking.**
  Every write does read-full-file → mutate → write-full-file, with no
  protection against two Node processes (e.g. the live `server.js` mid
  auto-check, and a one-off `node -e "require('./store')..."` script
  run from a terminal at the same time) racing on `data/events.json`.
  Under normal single-process use this is fine. It only matters when
  *deliberately* running an ad-hoc script against the store while the
  live server might also be mid-write — prefer the dashboard's own
  authenticated HTTP API (`curl -u user:pass -X POST/DELETE ...`) for
  mutations instead of a separate script when the server is running,
  since that funnels through the same single process instead of a
  second one. (This was investigated on 2026-09-21 after Electra/Persona
  briefly appeared to vanish unexpectedly — turned out to be the user
  deleting it deliberately, not this race, but the risk is real and
  worth knowing about.)
- Per-date/per-time performance tracking is implemented (`store.js`) —
  each event can show several date/time rows, each with its own
  sold-out/available status, instead of one status for the whole event.
- **All three events now check a real per-performance data source
  instead of guessing from page text** (this was the main open item as
  of the previous handoff — now resolved):
  - **Barbican (Murakami Jazz)**: `checkers/htmlInstancesChecker.js`,
    recipe `{ mode: 'html-instances', venue: 'barbican', instancesUrl }`.
    A plain GET to `https://www.barbican.org.uk/node/<nodeId>/instances`
    (this event's node id is `225005`) returns a JSON-encoded HTML
    string with one `<time datetime="...">` + sold-out/book-now button
    per showtime. No cookies/session needed. This *replaced* the old
    text-scraping approach for this event, which quietly broke at some
    point — the venue moved the real availability text into this
    lazily-loaded overlay, off the main page's visible text entirely, so
    `page.innerText()` stopped seeing it (it showed as "1 performance ->
    unknown" instead of the real 2 showtimes). Confirmed fixed: now
    correctly reads both the 5pm and 8.30pm showtimes.
  - **Golden Boy (Almeida)**: same `htmlInstancesChecker.js`, recipe
    `{ mode: 'html-instances', venue: 'golden-boy', ajaxUrl, filters }`.
    A plain POST to `https://almeida.co.uk/admin/wp-admin/admin-ajax.php`
    with body `action=calendar&filters=event=11278&date_range=` returns
    `{ instances: [htmlFragment, ...] }`, one fragment per performance,
    each with a real datetime and a genuine sold-out/available
    indicator. No auth/nonce needed. Confirmed fixed: now correctly
    reads all 47 real performances (the old heuristic was picking up
    11 mostly-bogus "performances" — opening hours, NT Live screening
    dates, etc., not real per-night status).
  - **Bob Dylan (Southbank Centre)**: `checkers/interceptChecker.js`,
    recipe `{ mode: 'intercept-api', pageUrl, apiUrlPattern,
    productionSeasonIds }`. This one *couldn't* be replicated as a
    plain HTTP call — Southbank's `/api/products/productionseasons`
    endpoint 500s on every guessed request body, and the event page
    sits behind a queue-it virtual waiting room first. Instead, this
    checker loads the real page in the shared Playwright browser and
    listens for the same JSON response the page's own JS receives
    (clean `isOnSale` / `hasLimitedSeatingAvailable` /
    `performanceStatusMessage` fields per performance — no HTML
    parsing needed at all). Confirmed fixed: now correctly reads all
    10 real performances (5 main + 5 "Exclusive box package", both
    currently sold out).
  - `checkers/index.js` routes on `recipe.mode` and falls back to the
    old render/text-scrape checker if any of these ever error (endpoint
    renamed, node id changed, etc.) — same safety-net principle as the
    pre-existing `api` mode.
  - New tests: `test/htmlInstancesChecker.test.js` (pure logic, no
    network — run with `node test/htmlInstancesChecker.test.js`).
- **Fixed (2026-09-20)**: `interceptChecker.js` (Bob Dylan) occasionally
  errored under this machine's memory pressure and fell back to
  rendering `event.url` — the venue's marketing page, which has no real
  per-date text at all, so it showed "unknown" and looked broken on the
  dashboard even though nothing was actually wrong with detection.
  Two fixes: (1) it now retries once with a fresh browser context
  before giving up (a transient hiccup is usually gone on retry), and
  (2) the fallback in `checkers/index.js` now renders `recipe.pageUrl`
  (the actual ticketing page, which *does* show real per-date "Sold
  out" text) instead of `event.url`.
- **Fixed (2026-09-20)**: `checkers/parseMultiText.js` (the render-mode
  text-scraper, used as a fallback and for any newly-added event) was
  picking up bogus "performances" from marketing copy that mentions
  dates without being real showtimes — a header date range before the
  real listing, "tickets available from 28 Sept" prose, etc. Added
  `trimBeforeDatesHeading()`, which cuts the text to start at a literal
  "Dates and times for <show>" heading when one is found (mirrors the
  existing `trimAtRelatedSection` cutoff, just at the other end). Also
  extended the existing "doors 4.30pm"-style pre-show-time filter to
  also drop "Touch Tour at 5.30pm" access slots, which were generating
  a duplicate, wrongly-"unknown" entry next to the real showtime. Real
  bug found via the Electra/Persona test event below. New regression
  test: the "National Theatre" case in `test/parseMultiText.test.js`.
- **Fixed (2026-09-21)**: `checkers/htmlInstancesChecker.js`'s
  `extractInstances()` had a real, live bug — not a test-only issue.
  When a Barbican `/node/<id>/instances` response lists only one
  performance (or for the LAST one in a multi-performance response),
  splitting on `<time>` tags leaves that instance's "part" running all
  the way to the end of the raw response, which sweeps in the trailing
  "Join" (membership) tab. That tab's own marketing copy happens to say
  "Access to Sold-out Events... secure tickets for sold-out shows" as a
  membership perk — totally unrelated to the actual performance. This
  made a genuinely *available* screening (Godzilla 2000: Millennium,
  22 Sep) read as sold out on the dashboard, which is how the user
  caught it — they checked the real Barbican site and saw it looked
  different. Fixed by capping the sold-out search to
  `MAX_INSTANCE_WINDOW` (1500 chars) after each `<time>` tag, comfortably
  covering the real nearby button while cutting off long before the
  Join tab. Confirmed fixed live, and the fix itself immediately
  produced a real, correct "available" notification via the running
  app (not a synthetic test) — good end-to-end proof the whole pipeline
  works. Murakami Jazz (2 performances, genuinely still sold out both)
  confirmed unaffected. New regression test in
  `test/htmlInstancesChecker.test.js`. **Worth double-checking Golden
  Boy too if this ever recurs** — its fetcher calls `extractInstances`
  per-fragment already (each fragment is one complete array item, not a
  shared trailing blob), so it should be structurally immune, but it
  hasn't been deliberately stress-tested for this exact class of bug the
  way Barbican now has.
- **Fixed**: a black browser window was popping up during checks (see
  `browser.js` — forces the full Chromium build via `channel:
  'chromium'` instead of the headless-shell binary).
- **Fixed**: the machine hitting ~96%+ RAM usage was crashing Chromium
  mid-check and cascading into every other event failing too.
  `runChecks.js` detects a dead browser connection and relaunches
  instead of reusing it. Note: this machine is still memory-constrained
  (7.7GB total, often <1GB free even at idle) — if checks start
  erroring with "Page crashed" again, that's almost certainly why; no
  code change needed, just less other stuff running at once.
- **Added (2026-09-21): the dashboard is now publicly shareable
  (read-only) via a Cloudflare Tunnel**, per the user's request to host
  it "like the stays website." Two parts:
  - `server.js`: auth is now scoped, not global. `GET /api/events`,
    `GET /api/status`, and the dashboard page itself stay open to anyone
    with the link. Every route that changes something (add/remove/recheck
    an event, test-notify) now requires `DASHBOARD_USER`/`DASHBOARD_PASSWORD`
    via the `requireAuth` middleware — these are now SET in `.env`
    (user: `eliette`). Visit `/admin` once as a real page load (not a
    button click) to trigger the browser's native login prompt; after
    that, the browser caches those credentials for the origin and the
    dashboard's own buttons (Add/Remove/Recheck/Test notify) just work
    normally in that browser.
  - A second pm2 process, `ticket-watcher-tunnel`, runs `cloudflared
    tunnel --url http://localhost:3000` (installed via winget at
    `C:\Program Files (x86)\cloudflared\cloudflared.exe`). This is a
    **quick/anonymous tunnel** — no Cloudflare account or domain needed
    (the user explicitly chose to keep it free rather than buy/connect a
    domain for a stable *named* tunnel — don't switch to that without
    asking again), but the public URL is random and changes every time
    the tunnel process restarts. **Always read the current URL from
    `tunnel-url.txt`** in the project root (kept up to date automatically
    — see the watchdog below) rather than assuming a URL from an earlier
    message is still current, or grepping pm2 logs by hand.
  - **`tunnel-watchdog.js`, a third pm2 process
    (`ticket-watcher-tunnel-watchdog`), added 2026-09-22 after this was
    hit live**: the tunnel's underlying connection can die from a
    network hiccup, after which Cloudflare's edge invalidates that
    specific session ("Unauthorized: Tunnel not found") and cloudflared
    does NOT recover on its own — it just retries the same dead session
    forever. It sat broken for 40+ minutes before anyone noticed, with
    pm2 still showing it as "online" the whole time (the *process*
    didn't crash, just the tunnel it was maintaining). The watchdog
    tails `ticket-watcher-tunnel`'s own pm2 log file every 5s for that
    exact failure signature and, on seeing it, shells out to `pm2
    restart ticket-watcher-tunnel` — turning a silent, indefinite outage
    into a brief, self-healing one (confirmed working end-to-end by
    deliberately injecting a fake error line into the log and watching
    it detect, restart, and recover with a fresh URL). It also writes
    the current URL to `tunnel-url.txt` on every new tunnel. Deliberately
    does NOT spawn/own the cloudflared process itself (an earlier version
    did, as a child process, but reliably killing a child process tree on
    a forced stop turned out to be unreliable on Windows and left an
    orphaned `cloudflared.exe` behind in testing) — it only reads a log
    file and calls the `pm2` CLI, reusing process management pm2 already
    does reliably here rather than reimplementing it.
  - Letting other people add their *own* events (not just view) was
    explicitly deferred by the user — don't build that without asking
    again; it needs real per-user data isolation and guardrails against
    pointing the browser-automation checkers at arbitrary attacker URLs.
- **Added (2026-09-21): viewer/admin page split, plus an in-page ntfy
  explainer.** `public/index.html` (the public viewer page, served at
  `/`) no longer has the "Add an event" form — anyone with the link can
  see events and Recheck/Remove (the latter two still 401 without
  login), but adding is gone from that page entirely. It now also has a
  "What is this? / Get notified yourself" section explaining the tool
  and walking a visitor through installing ntfy (iOS + Android links)
  and subscribing to the topic — populated dynamically from
  `GET /api/status`'s new `ntfy: {topic, server}` field (safe to expose:
  the topic name is meant to be handed out, that's the whole point).
  `admin.html` (moved to the project ROOT, deliberately *outside*
  `public/` — Express's static middleware would otherwise serve it
  directly at `/admin.html`, bypassing `requireAuth` entirely) has the
  Add-event form and is what `/admin` actually serves. `app.js` is
  shared by both pages; the add-form listener is now optional-chained
  (`?.addEventListener`) since index.html no longer has that element.
- **Fixed (2026-09-21): a second real, live bug in
  `checkers/parseMultiText.js`, found via the Electra/Persona test
  event — and this one had already sent real notifications naming the
  WRONG performance as available.** The National Theatre's booking page
  prints every performance's date+time TWICE: once as a "Tue 22
  September 2026 at 7:00 pm" heading, then again as two separate lines
  right before the actual status. That duplication desynced the
  "pair each time with whichever date precedes it" windowing logic
  across the wrong performances — right NUMBER of "available" results,
  attached to the wrong specific dates (notifications went out for e.g.
  "28 September" and "01 October" when the performances that were
  actually available were 22 September and 23 September 1pm). Fixed
  with a new `stripWeekdayDateAtTimeHeadings()` that strips the
  redundant heading line before tokenizing (it's pure duplication of
  what immediately follows, safe to drop). Confirmed against the live
  page after the fix: correctly reads 22 Sep 7pm and 23 Sep 1pm (filmed)
  as available, everything else sold out — matches the real site
  exactly. **If the user mentions getting a notification for Electra/
  Persona naming a date that turns out to still be sold out, that's
  this bug, from before the fix landed — the real available date(s)
  are whatever the dashboard shows now, not what an old notification
  said.** New regression test in `test/parseMultiText.test.js`
  ("NT duplicate-heading bug") reproduces the exact real page structure
  verbatim, asserting each specific date lands on the right status, not
  just the right count — the previous "Case 6" synthetic fixture for
  this same page had *missed* this bug because it didn't happen to
  include the duplicate date line, which is exactly why the new test
  is more valuable: it's copied from a real captured page dump, not
  hand-simplified. **Any other render-mode-checked event should be
  treated as at-risk of the same "right count, wrong labels" failure
  mode** if its venue's page has this kind of duplicated
  heading-then-breakdown structure — worth eyeballing the raw text
  (`page.locator('body').innerText()`) rather than just trusting a
  count match, if one is ever added.

## Nothing currently in progress

The per-date accuracy issue that was the main open item in the previous
handoff (Golden Boy and Bob Dylan showing noisy, mostly-bogus "performance"
counts) is resolved — see above. If a similar issue shows up again (a
checker suddenly reporting far fewer/more performances than expected, or
everything reading "unknown"), the playbook that worked here was:

1. Open the venue's actual event/calendar page in a real browser and
   check the network tab for JSON/AJAX calls the page's own JS makes —
   ticket widgets almost always load real per-performance data this way
   even when the marketing page's visible text doesn't show it.
2. If a plain HTTP call can replicate that request (check request
   method/body/headers), add it to `checkers/htmlInstancesChecker.js`
   (or a new lightweight module) — no browser needed per check.
3. If it can't be replicated as a plain HTTP call (bot detection,
   opaque tokens, a virtual queue), use `checkers/interceptChecker.js`'s
   pattern instead: load the real page in Playwright and read the same
   response the page's own JS receives.
4. Either way, wire the new recipe `mode` into `checkers/index.js` (and
   `runChecks.js` / `server.js`'s `needsBrowser` checks if it's an
   HTTP-only mode) with a render-mode fallback on error.

## Files

Everything is already saved in `D:\codingwizard\Barbican magic`.

- **Core app**: `server.js`, `check.js`, `runChecks.js`, `browser.js`,
  `store.js`, `notify.js`, `checkers/*.js`, `public/*`,
  `data/events.json` (the real event data), `.env` (real config, not
  reproduced here)
- **Checkers**: `checkers/index.js` (routes on recipe mode),
  `checkers/renderChecker.js` (text-scrape fallback, still the default
  for any newly-added event), `checkers/parseMultiText.js` +
  `checkers/classify.js` (used by the fallback),
  `checkers/htmlInstancesChecker.js` (Barbican + Golden Boy, plain
  HTTP), `checkers/interceptChecker.js` (Bob Dylan, browser
  response-interception), `checkers/apiChecker.js` (generic single-value
  JSON API checker, not currently used by any configured event),
  `checkers/discover.js` (used by the dashboard's "add event" flow).
- **Tests**: `test/*.test.js` — run with e.g. `node
  test/parseMultiText.test.js` (also `classifier.test.js`,
  `store.test.js`, `htmlInstancesChecker.test.js`). `npm test` only
  runs `classifier.test.js`; run the others individually. All passing
  as of this handoff.
- **Docs**: `README.md`, `.env.example`

## Environment notes

`.env` (already set on this machine): `NTFY_TOPIC=BARBICAN-1999` for
push via ntfy.sh, `POLL_INTERVAL_MINUTES=10`, `AUTO_CHECK` defaults to
true, no SMTP/email configured, no dashboard login
(`DASHBOARD_USER`/`DASHBOARD_PASSWORD` blank — fine for localhost-only
use).

Running under pm2 as process `ticket-watcher`, set to survive reboots
via `pm2-windows-startup`. Useful commands:

```
pm2 status
pm2 restart ticket-watcher
pm2 logs ticket-watcher --lines 60 --nostream
pm2 save        # after any change to how it's started
```

If you edit `data/events.json` by hand, `pm2 stop ticket-watcher` first
(the running process periodically reads and rewrites this file on its
own check cycle, so editing it while running risks a write race), then
`pm2 start ticket-watcher` once done.
