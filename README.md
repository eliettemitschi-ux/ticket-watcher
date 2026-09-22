# Ticket Watcher

Watches sold-out event pages and tells you (push notification and/or
email) the moment one opens back up, so you can jump on returned tickets
before anyone else. Comes with three events already set up:

- Barbican — *Haruki Murakami's Jazz at Peter Cat* (only notifies for the
  8.30pm evening show — see "Multiple dates and times" below)
- Almeida Theatre — *Golden Boy*
- Southbank Centre — *Bob Dylan*

and a dashboard for adding more, from the Barbican, the Almeida, Southbank
Centre, or (with one caveat below) most other venues too.

## How it works

Most theatre/concert booking pages don't show "Sold out" or "Book now" as
plain text in the page's HTML — they load it in afterwards with
JavaScript, which is why a simple page download isn't enough. This
project handles that two ways:

1. **Fast path (API mode).** When you add an event, it loads the page
   once in a real (headless) browser and watches the network traffic for
   the underlying JSON call the booking widget itself makes (Barbican and
   the Almeida both run on **Spektrix**, a ticketing platform used by a
   lot of UK arts venues, which exposes this kind of data). If it finds
   one and it checks out, every future poll is just a plain, cheap HTTP
   request — no browser needed.
2. **Fallback (render mode).** If no such endpoint is found (or the venue
   isn't on Spektrix), it falls back to loading the actual page in a
   headless browser every time and reading whether it says "sold out" or
   shows an active booking button. Slower and heavier, but it works on
   basically any venue's site, which is why it's also what the two seed
   events start on — they'll self-upgrade to the fast path the first time
   you add them (or the next time you re-add them) if a clean endpoint is
   found.

Either way, the result is compared to what it was last time, and a
notification only fires the moment an event flips **from** sold out
**to** available — not on every check.

## Multiple dates and times

A long run like *Golden Boy* can have a dozen individual dates, each
selling out or reopening on its own, and a single date like the Murakami
show can have more than one showtime (a 5pm matinee and an 8.30pm
evening). So every check reads the *whole* page and pulls out every
date/time it can find, checking each one's own status separately rather
than boiling the page down to one status for the entire event. The
dashboard shows each one as its own row once there's more than one.

This is done by looking for date- and time-shaped text near each listed
performance (see `checkers/parseMultiText.js`) — it's a heuristic, not a
real reading of the booking calendar's own markup, so every row also
shows the exact snippet of page text it matched (in small grey italics).
If a status ever looks wrong, that snippet is the first thing to check —
it usually makes clear whether the checker read the right bit of the
page.

**Only notify me for...** — each event has an optional filter (set it
from the "Add event" form, or edit it later right on the event's card).
Leave it blank to be notified about *any* date/time becoming available;
set it to something like `8.30pm` to only ever be pinged for a
performance whose date/time label contains that text. Every date/time is
still checked and shown on the dashboard regardless of the filter — it
only controls which ones are worth waking you up for. The seed Murakami
event ships with this set to `8.30pm` already, since that's the showtime
asked for when this was built.

## One-time setup

```bash
npm install
npx playwright install chromium   # downloads the headless browser (~150MB)
cp .env.example .env
```

Open `.env` and fill in at least one notification channel:

- **Push (recommended, fastest):** pick any hard-to-guess topic name and
  set `NTFY_TOPIC=` to it, e.g. `eliette-tickets-8f2a`. Then subscribe to
  that same topic in the [ntfy app](https://ntfy.sh/) (iOS/Android) or at
  `https://ntfy.sh/app` in a browser. Free, no account needed.
- **Email:** fill in `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS`
  / `NOTIFY_EMAIL_TO` with whatever mailbox/provider you already use for
  the other website.

You can set both — the check script fires every channel that's configured.

Also set `DASHBOARD_USER` / `DASHBOARD_PASSWORD` in `.env` before putting
this on a public-facing server, otherwise anyone who finds the URL can
see (and edit) your watch list.

## Running it

Just one thing to run:

```bash
node server.js
```

Visit `http://your-server:3000` (or whatever `PORT` you set). As long as
this keeps running, every event gets checked automatically every
`POLL_INTERVAL_MINUTES` (10 by default — see `.env`) — nothing else to
install, schedule, or remember to start. The dashboard's subtitle line
says so ("Checking automatically every ~10 min"); if it instead says
automatic checking is off, `AUTO_CHECK` got set to `false` in `.env`.

Adjust `POLL_INTERVAL_MINUTES` to taste — every 5–10 minutes is plenty
for personal use and unlikely to draw any attention from the venue's
site. There's no need to check more often than that: sold-out shows
don't usually release seats mid-second.

Since this only checks while it's running, leave the terminal window (or
`npx pm2 start server.js --name ticket-watcher`, so it survives logging
out) open on whatever machine you're using — closing it pauses checking
until you start it again.

### If you'd rather use Task Scheduler/cron instead

Some setups genuinely want checking to keep happening even when the
dashboard itself isn't running (a server that gets restarted often, for
instance). For that, set `AUTO_CHECK=false` in `.env` and run `check.js`
— the exact same checking/notifying logic, just as its own short-lived
script — from your own scheduler:

**Windows (Task Scheduler):** Task Scheduler → Create Basic Task → set a
trigger to repeat every 10 minutes → Action: "Start a program" →
Program: `node`, Arguments: `check.js`, "Start in": this project's
folder.

**Linux/Mac (cron):**

```bash
crontab -e
# check every 10 minutes:
*/10 * * * * cd /path/to/ticket-watcher && node check.js >> check.log 2>&1
```

For most personal setups the built-in automatic checking above is simpler
(one thing to run, nothing to configure in the OS) — only reach for this
if you have a specific reason to.

## Adding more events

Either use the "Add event" form on the dashboard (paste the event's URL,
give it a name, hit add — it checks immediately and tells you the
current status), or from the command line:

```bash
node discover.js "https://almeida.co.uk/whats-on/golden-boy/" "Golden Boy" "Almeida Theatre"

# with a "only notify me for" filter (see "Multiple dates and times" above):
node discover.js "https://www.barbican.org.uk/whats-on/2026/event/haruki-murakamis-jazz-at-peter-cat" "Murakami Jazz" "Barbican" "8.30pm"
```

Both do the same discovery step described above. It takes a few seconds
per event since it has to load the real page once.

For a venue whose booking flow sits behind its own bot-protection or a
virtual queue (a "Verifying you are human", Incapsula, or Queue-it style
page) — Southbank Centre's own checkout is one example — point the URL at
the venue's normal public event page instead of the checkout/booking
link. That public page almost always already shows the plain "Sold Out"
text itself (exactly like Barbican and the Almeida do), so there's no
need to touch the protected checkout at all just to watch for
availability.

### Other venues

Because the fallback (render mode) reads the actual rendered page text
for common phrases ("sold out", "fully booked", "book now", "choose your
seats", etc. — see `checkers/classify.js`), it works out of the box for
most UK theatre/venue sites without any per-venue code. If you add a
venue whose page uses very different wording, and it comes back as
"unknown" repeatedly instead of "sold out" or "available", open
`checkers/classify.js` and add the phrase you see on their page to the
`SOLD_OUT_PATTERNS` or `AVAILABLE_PATTERNS` list — no other code needs to
change.

If a venue also runs on Spektrix (Southbank Centre, Sadler's Wells, the
National Theatre, and a good few other UK arts venues do), the fast-path
discovery will very likely pick it up the same way it does for Barbican
and the Almeida, with no extra work.

## Project layout

```
server.js         the dashboard (Express) + REST API + automatic checking
runChecks.js       the actual "check everything, notify" logic -- used by
                    both server.js's automatic checking and check.js
check.js          optional standalone script, for Task Scheduler/cron
                    instead of server.js's automatic checking
discover.js        CLI: add one event and run first-time discovery
browser.js         shared Chromium-launch helper
store.js           tiny JSON-file store for events + their last status
notify.js          ntfy.sh + email notifications
checkers/
  classify.js       pure text -> sold_out/available classifier (unit tested)
  parseMultiText.js finds every date/time on a page and classifies each one
                     separately (unit tested)
  apiChecker.js     lightweight JSON-endpoint checker
  renderChecker.js  headless-browser page-text checker (the fallback)
  discover.js       finds + calibrates a fast-path API recipe, if one exists
  index.js          picks the right checker for a given event
public/            the dashboard's HTML/CSS/JS (no build step)
data/events.seed.json   the events you asked to start with
test/              unit tests -- run any of them with `node test/<file>`
```

## Notes

- This is unofficial use of each venue's site — be a good citizen about
  the polling interval (see above), and don't be surprised if a venue's
  page markup changes and needs the odd tweak.
- `data/events.json` is where your actual watch list lives once the
  server has run once (it's gitignored — back it up yourself if that
  matters to you).
