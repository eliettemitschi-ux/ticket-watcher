# Ticket Watcher — what this is

## The problem

Some of the best shows in London — a play, a gig, a one-off screening —
sell out fast, sometimes before you even hear about them. But "sold
out" is rarely the end of the story. Tickets trickle back: someone
cancels, a venue releases a few more seats, a discount batch opens up
on a schedule. The catch is that catching one of those moments usually
means refreshing a booking page over and over, hoping to be there at
the right second. Nobody wants to do that.

## What this does

This is a small personal tool that does the refreshing for you. You
tell it which sold-out shows you care about, and it quietly checks each
one every few minutes. The instant a show that was sold out actually
becomes bookable again, it sends a push notification straight to your
phone — so you find out within minutes, not by luck.

It's not a bot, it's not trying to buy tickets for you, and it doesn't
need an account with the venue. It just watches, and taps you on the
shoulder the moment something changes.

## How it works, in plain terms

Every few minutes, it visits each watched show's real booking page —
the same page you'd look at yourself — and reads whether tickets are
available. It remembers what it saw last time. If a date that was
sold out is now bookable, that's a real change, and that's the moment
it sends you a notification. If nothing's changed, it stays quiet.

Some shows have several separate dates or showtimes (a whole theatre
run, say), so it tracks each one individually rather than treating the
whole show as one big "sold out or not." That way you get told exactly
which date opened up, not just that something, somewhere, might have.

## Where the information comes from

Straight from each venue's own official website — the exact same
booking page you'd land on if you searched for the show and clicked
"Book tickets" yourself. Nothing comes from a resale site, a scalper,
or some third-party aggregator, and nothing is scraped from anywhere
shady — it's just reading the same public page anyone can look at,
automatically and often.

Right now it's watching:

- **Haruki Murakami's Jazz at Peter Cat** — Barbican
- **Golden Boy** — Almeida Theatre
- **Bob Dylan** — Southbank Centre
- **Conservatory Sunday** — Barbican

The list isn't fixed — shows get added or removed over time as
interest changes.

## Getting notified yourself

Notifications go out through a free app called **ntfy** — think of it
as a simple, no-account-needed doorbell. Install it on your phone
(iPhone or Android), subscribe to one topic name, and you'll get the
same alerts this tool sends, the moment they happen. There's a "Get
notified yourself" section on the dashboard page itself with the exact
steps.

You can also just look at the dashboard any time to see, at a glance,
which watched shows are sold out right now and which have opened up —
no notification needed for that part.

## How it came to exist

This started as a very small, very specific itch: wanting to know the
moment tickets opened up for a particular sold-out show, without
babysitting a browser tab. It was built gradually, in conversation,
with Claude Code doing the actual building — describing what was
wanted, watching it get built, then testing it against the real world
and fixing whatever didn't quite match reality.

That last part mattered more than expected. A few things that looked
right at first glance turned out to be reading the wrong signals once
checked against the *actual* live site — a show that looked sold out
was really bookable, or a notification pointed at the wrong date. Each
time that happened, it got caught by deliberately testing against real,
currently-sold-out shows (not made-up examples) and comparing what the
tool said to what the venue's own website actually showed. So the
version running now has been checked against reality more than once,
not just written and trusted.

It keeps running quietly in the background on its own, checking
everything automatically, with no need to open a laptop or remember to
look.
