// docs/stats.js -- works out, from the hourly Snap price log (snap-history.json in
// the private repo), when tickets appear, how prices move and how long tickets
// last. Used by the owner-only Stats tab; nothing private is in this file.
//
// The log holds only CHANGES, as flat events [time, route, date, price, kind]
// (see trains/history.js for what each kind means). A "date" is a travel day, and
// each one goes through a life: first seen (usually not on sale yet), tickets
// appear at some price, the price may change, tickets may go.
//
// Every figure comes with how many dates it is based on, and anything under
// THIN dates is flagged: a few weeks of data is a small sample.

(function (root) {
  'use strict';

  const TZ = 'Europe/London';
  const THIN = 8;
  const ROUTE_NAMES = { 'london-paris': 'London → Paris', 'paris-london': 'Paris → London' };
  const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  // A date whose tickets go with at most this many days to travel is "closed late":
  // we cannot tell sold out from the sale simply ending.
  const LATE_DAYS = 1;

  // --- Small helpers -----------------------------------------------------------

  const ms = (t) => Date.parse(String(t).replace(/Z$/, ':00Z'));
  const londonFmt = (opts) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...opts });
  const londonDate = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ms(t)));
  const londonHour = (t) => Number(londonFmt({ hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms(t))));
  const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
  const weekdayIndex = (date) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0

  const sortNum = (xs) => [...xs].sort((a, b) => a - b);
  function median(xs) {
    if (!xs.length) return null;
    const s = sortNum(xs);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function mode(xs) {
    const counts = new Map();
    for (const x of xs) counts.set(x, (counts.get(x) || 0) + 1);
    let best = null;
    for (const [x, n] of counts) if (best === null || n > best.n || (n === best.n && x < best.x)) best = { x, n };
    return best ? best.x : null;
  }
  const round1 = (x) => (x === null ? null : Math.round(x * 10) / 10);
  const histogram = (xs) => {
    const counts = new Map();
    for (const x of xs) counts.set(x, (counts.get(x) || 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([value, count]) => ({ value, count }));
  };
  const summary = (xs) => ({ n: xs.length, median: round1(median(xs)), min: xs.length ? Math.min(...xs) : null, max: xs.length ? Math.max(...xs) : null });

  // --- The life of each travel day ------------------------------------------------

  // Walks one day's events (oldest first) and notes what happened to it.
  function lifeOf(date, events) {
    const life = { date, firstSeen: null, appearedAt: null, appearedPrice: null, alreadyOnSale: false, prices: [], changes: [], goneAt: null, returns: 0, onSale: false, price: null };
    let sawNull = false;
    for (const [t, , , price, kind] of events) {
      if (kind === 'i') {
        life.firstSeen = t;
        if (price === null) sawNull = true;
        else { life.alreadyOnSale = true; life.onSale = true; life.price = price; life.prices.push({ t, price }); }
      } else if (kind === 'n') {
        if (life.appearedAt === null && sawNull) { life.appearedAt = t; life.appearedPrice = price; } else if (life.goneAt) life.returns += 1;
        life.onSale = true; life.price = price; life.prices.push({ t, price });
      } else if (kind === 'c') {
        const was = life.price;
        life.changes.push({ t, from: was, to: price });
        life.price = price; life.prices.push({ t, price });
      } else if (kind === 'g') {
        if (life.goneAt === null) life.goneAt = t;
        life.onSale = false; life.price = null;
      }
    }
    return life;
  }

  // Hours the tickets stayed on sale, from when they appeared to when they first went.
  const hoursOnSale = (life) => (life.appearedAt && life.goneAt ? (ms(life.goneAt) - ms(life.appearedAt)) / 3600000 : null);

  function analyseRoute(routeEvents) {
    const byDate = new Map();
    for (const e of routeEvents) {
      if (!e[2]) continue; // gap markers have no date
      if (!byDate.has(e[2])) byDate.set(e[2], []);
      byDate.get(e[2]).push(e);
    }
    const lives = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, evs]) => lifeOf(date, evs));

    // When tickets appear (only days whose "not on sale yet" start we actually saw).
    const appeared = lives.filter((l) => l.appearedAt);
    const lead = appeared.map((l) => daysBetween(londonDate(l.appearedAt), l.date));
    const hours = appeared.map((l) => londonHour(l.appearedAt));
    const byWeekday = WEEKDAYS.map((name, i) => {
      const day = lives.filter((l) => weekdayIndex(l.date) === i);
      const dayAppeared = day.filter((l) => l.appearedAt);
      const firsts = day.filter((l) => l.prices.length).map((l) => l.prices[0].price);
      return { name, dates: day.length, n: dayAppeared.length, medianLead: round1(median(dayAppeared.map((l) => daysBetween(londonDate(l.appearedAt), l.date)))), medianFirstPrice: median(firsts) };
    });

    // How prices move once tickets are on sale.
    const priced = lives.filter((l) => l.prices.length);
    const firsts = priced.map((l) => l.prices[0].price);
    const withChange = priced.filter((l) => l.changes.length);
    const anyDrop = priced.filter((l) => l.changes.some((c) => c.to < c.from));
    const anyRise = priced.filter((l) => l.changes.some((c) => c.to > c.from));
    const net = (l) => l.prices[l.prices.length - 1].price - l.prices[0].price;
    const netLower = priced.filter((l) => net(l) < 0);
    const netHigher = priced.filter((l) => net(l) > 0);
    const netChanges = withChange.map(net);
    const hoursToFirstChange = withChange.map((l) => (ms(l.changes[0].t) - ms(l.prices[0].t)) / 3600000);
    const biggestDrop = anyDrop.map((l) => ({ date: l.date, from: l.prices[0].price, to: Math.min(...l.prices.map((p) => p.price)) })).sort((a, b) => (b.from - b.to) - (a.from - a.to))[0] || null;

    // How long tickets last.
    const gone = lives.filter((l) => l.goneAt);
    const goneLate = gone.filter((l) => daysBetween(londonDate(l.goneAt), l.date) <= LATE_DAYS);
    const goneEarly = gone.filter((l) => daysBetween(londonDate(l.goneAt), l.date) > LATE_DAYS);
    const lasted = lives.map(hoursOnSale).filter((h) => h !== null);
    // Per travel day, for the same-date comparison and for saying where a chosen date stands.
    const appearances = {};
    for (const l of appeared) appearances[l.date] = ms(l.appearedAt);
    const firstPrices = {};
    for (const l of priced) firstPrices[l.date] = l.prices[0].price;
    const status = {};
    for (const l of lives) status[l.date] = l.onSale ? { state: 'on', price: l.price } : l.goneAt ? { state: 'gone' } : { state: 'not-yet' };

    return {
      tracked: lives.length,
      notOnSaleYet: lives.filter((l) => !l.onSale && !l.goneAt && !l.prices.length).length,
      alreadyOnSale: lives.filter((l) => l.alreadyOnSale).length,
      appearances,
      firstPrices,
      status,
      appear: { leadValues: sortNum(lead), lead: { ...summary(lead), mode: mode(lead), histogram: histogram(lead) }, hour: { n: hours.length, mode: mode(hours), median: median(hours), histogram: histogram(hours) } },
      byWeekday,
      price: {
        n: priced.length,
        firstPrice: summary(firsts),
        withChange: withChange.length, anyDrop: anyDrop.length, anyRise: anyRise.length, netLower: netLower.length, netHigher: netHigher.length,
        medianNetChange: round1(median(netChanges)),
        hoursToFirstChange: { n: hoursToFirstChange.length, median: round1(median(hoursToFirstChange)) },
        biggestDrop,
      },
      lasts: { onSaleNow: lives.filter((l) => l.onSale).length, goneEarly: goneEarly.length, goneLate: goneLate.length, returns: lives.reduce((n, l) => n + l.returns, 0), hours: { n: lasted.length, median: round1(median(lasted)) } },
    };
  }

  // Hours Snap did not answer, from the 'b' (blocked) and 'o' (ok again) markers.
  function gapHours(events, nowMs) {
    let hours = 0;
    const open = {};
    for (const [t, route, , , kind] of events) {
      if (kind === 'b') open[route] = ms(t);
      if (kind === 'o' && open[route] !== undefined) { hours += (ms(t) - open[route]) / 3600000; delete open[route]; }
    }
    for (const since of Object.values(open)) hours += (nowMs - since) / 3600000;
    return round1(hours);
  }

  /**
   * @param {object} history  the parsed snap-history.json
   * @param {number} nowMs
   */
  function analyse(history, nowMs) {
    const events = (history && history.events) || [];
    const routes = {};
    for (const id of Object.keys(ROUTE_NAMES)) routes[id] = analyseRoute(events.filter((e) => e[1] === id));
    const sinceMs = history && history.since ? ms(history.since) : nowMs;
    const checkedMs = history && history.checkedAt ? Date.parse(history.checkedAt) : null;
    return {
      since: history && history.since ? history.since : null,
      daysCollected: round1((nowMs - sinceMs) / 86400000),
      checkedAt: history && history.checkedAt ? history.checkedAt : null,
      hoursSinceCheck: checkedMs === null ? null : round1((nowMs - checkedMs) / 3600000),
      events: events.length,
      capped: Boolean(history && history.capped),
      blocked: (history && history.blocked) || {},
      gapHours: gapHours(events, nowMs),
      routes,
    };
  }

  // --- Direction comparison and the estimate for a chosen date ----------------------------

  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const addDaysIso = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const A_ID = 'london-paris';
  const B_ID = 'paris-london';
  const MIN_FOR_ESTIMATE = 3; // fewer than this many appearances and we say there is not enough data
  const WATCHED_DAYS = 21; // how far ahead the hourly job looks (HORIZON_DAYS in trains/history.js)

  /**
   * How sure to be about a lead-time estimate. Needs both enough dates and a tight
   * spread: High is 20+ dates with 80%+ within a day of the typical lead, Medium is
   * 8+ dates with 60%+, anything else is Low.
   */
  function confidenceFor(leads) {
    const n = leads.length;
    const med = median(leads);
    const within1 = n ? leads.filter((x) => Math.abs(x - med) <= 1).length / n : 0;
    const level = n >= 20 && within1 >= 0.8 ? 'High' : n >= 8 && within1 >= 0.6 ? 'Medium' : 'Low';
    return { level, n, within1 };
  }

  /**
   * When tickets for one travel date usually appear, on one route.
   * @param {object} route   one route from analyse().routes
   * @param {string} date    the travel day, YYYY-MM-DD
   * @param {string} todayIso today in London, YYYY-MM-DD
   */
  function estimate(route, date, todayIso) {
    if (!ISO_DATE.test(date || '')) return { kind: 'pick' };
    if (date < todayIso) return { kind: 'past' };
    const status = route.status[date];
    const out = { daysAway: daysBetween(todayIso, date), status: status ? status.state : 'unwatched', price: status && status.price !== undefined ? status.price : null };
    const leads = route.appear.leadValues;
    const n = leads.length;
    if (n < MIN_FOR_ESTIMATE) return { ...out, kind: 'thin', n };
    const sorted = sortNum(leads);
    const typical = Math.round(median(leads));
    // 90% of dates had appeared by this many days before travel.
    const byLead = [...sorted].reverse()[Math.ceil(0.9 * n) - 1];
    const lo = n >= 10 ? sorted[Math.floor(0.1 * (n - 1))] : sorted[0];
    const hi = n >= 10 ? sorted[Math.ceil(0.9 * (n - 1))] : sorted[n - 1];
    const hour = route.appear.hour;
    const hourCount = hour.histogram.find((h) => h.value === hour.mode);
    return {
      ...out,
      kind: 'estimate',
      n,
      typical,
      usualDate: addDaysIso(date, -typical),
      byLead,
      byDate: addDaysIso(date, -byLead),
      earliest: addDaysIso(date, -hi),
      latest: addDaysIso(date, -lo),
      range: [lo, hi],
      hourMode: hour.mode,
      hourCount: hourCount ? hourCount.count : 0,
      hourN: hour.n,
      confidence: confidenceFor(leads),
    };
  }

  // The same dates in both directions: who appears first, and who is cheaper.
  function pairedDates(a, b, pick) {
    return Object.keys(pick(a)).filter((d) => d in pick(b)).sort();
  }

  function compare(stats) {
    const a = stats.routes[A_ID];
    const b = stats.routes[B_ID];
    // When tickets appear: overall, and on the dates both directions have.
    const timingDates = pairedDates(a, b, (r) => r.appearances);
    const gaps = timingDates.map((d) => (b.appearances[d] - a.appearances[d]) / 3600000); // hours: positive means London → Paris was first
    const sameTime = gaps.filter((g) => Math.abs(g) <= 1).length;
    const aEarlier = gaps.filter((g) => g > 1).length; // B - A is positive: London → Paris appeared first
    const bEarlier = gaps.filter((g) => g < -1).length; // B - A is negative: Paris → London appeared first
    const leadA = a.appear.lead;
    const leadB = b.appear.lead;
    const enough = leadA.n >= THIN && leadB.n >= THIN;
    const leadDiff = enough ? round1(leadB.median - leadA.median) : null;
    // Price level: the first price on the same travel dates.
    const priceDates = pairedDates(a, b, (r) => r.firstPrices);
    const diffs = priceDates.map((d) => b.firstPrices[d] - a.firstPrices[d]); // negative: Paris → London cheaper
    const bCheaper = diffs.filter((x) => x < 0).length;
    const aCheaper = diffs.filter((x) => x > 0).length;
    const priceEnough = priceDates.length >= THIN;
    // Price changes after tickets appear.
    const chA = a.price;
    const chB = b.price;
    const chEnough = chA.n >= THIN && chB.n >= THIN;
    const shareA = chA.n ? chA.withChange / chA.n : null;
    const shareB = chB.n ? chB.withChange / chB.n : null;
    return {
      timing: {
        a: { n: leadA.n, median: leadA.median, mode: leadA.mode, hourMode: a.appear.hour.mode, hourN: a.appear.hour.n },
        b: { n: leadB.n, median: leadB.median, mode: leadB.mode, hourMode: b.appear.hour.mode, hourN: b.appear.hour.n },
        enough,
        leadDiff, // days: positive means Paris → London appears earlier (a bigger lead)
        paired: { n: timingDates.length, aEarlier, bEarlier, sameTime, medianGapHours: round1(median(gaps)) },
      },
      price: {
        a: { n: chA.n, median: chA.firstPrice.median },
        b: { n: chB.n, median: chB.firstPrice.median },
        paired: { n: priceDates.length, aCheaper, bCheaper, equal: diffs.length - aCheaper - bCheaper, medianDiff: round1(median(diffs)) },
        enough: priceEnough,
      },
      changes: {
        a: { n: chA.n, withChange: chA.withChange, anyDrop: chA.anyDrop, anyRise: chA.anyRise },
        b: { n: chB.n, withChange: chB.withChange, anyDrop: chB.anyDrop, anyRise: chB.anyRise },
        enough: chEnough,
        shareDiff: chEnough ? round1(100 * (shareB - shareA)) : null, // percentage points
      },
    };
  }

  // --- Showing it -------------------------------------------------------------------

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pounds = (x) => (x === null || x === undefined ? 'n/a' : `£${Number.isInteger(x) ? x : x.toFixed(1)}`);
  // +£2.5, −£15 or £0: the sign comes first.
  const signed = (x) => (x === null || x === undefined ? 'n/a' : x < 0 ? `−${pounds(-x)}` : x > 0 ? `+${pounds(x)}` : pounds(0));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : 'n/a');
  const hourLabel = (h) => `${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00`;
  const thin = (n) => (n < THIN ? ' <span class="stat-thin">few dates, treat as a hint</span>' : '');
  const dayLabel = (date) => londonFmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00Z`));

  function bars(items, label) {
    const max = Math.max(1, ...items.map((i) => i.count));
    return `<div class="stat-bars">${items.map((i) => `<div class="stat-bar-row"><span class="stat-bar-label">${esc(label(i.value))}</span><span class="stat-bar-track"><span class="stat-bar-fill" style="width:${Math.round((100 * i.count) / max)}%"></span></span><span class="stat-bar-n">${i.count}</span></div>`).join('')}</div>`;
  }

  function routeHtml(id, r) {
    const lead = r.appear.lead;
    const parts = [`<h2 class="section-title">${esc(ROUTE_NAMES[id])}</h2>`];
    parts.push(`<div class="event-card"><div class="event-main">
      <p class="event-name">${plural(r.tracked, 'travel day', 'travel days')} watched</p>
      <p class="event-venue">${r.lasts.onSaleNow} on sale now · ${r.notOnSaleYet} not on sale yet · ${r.alreadyOnSale} already on sale when first seen (so their start is unknown)</p></div></div>`);

    parts.push('<h3 class="stat-head">When tickets appear</h3><div class="event-card"><div class="event-main">');
    if (!lead.n) parts.push('<p class="hint">No day has gone from "not on sale" to "on sale" since collecting began, so there is nothing to report yet.</p>');
    else {
      parts.push(`<p class="stat-line"><strong>${lead.mode} days before travel</strong> is the most common (median ${lead.median}, from ${lead.min} to ${lead.max}). Based on ${plural(lead.n, 'day', 'days')}.${thin(lead.n)}</p>`);
      parts.push(bars(lead.histogram, (v) => `${v} days before`));
      const hr = r.appear.hour;
      parts.push(`<p class="stat-line">Most often they appear between <strong>${hourLabel(hr.mode)}</strong> London time (${hr.histogram.find((h) => h.value === hr.mode).count} of ${hr.n}).${thin(hr.n)}</p>`);
      parts.push(bars(hr.histogram, (v) => hourLabel(v)));
    }
    parts.push('</div></div>');

    const p = r.price;
    parts.push('<h3 class="stat-head">Do prices change?</h3><div class="event-card"><div class="event-main">');
    if (!p.n) parts.push('<p class="hint">No prices seen yet.</p>');
    else {
      parts.push(`<p class="stat-line">First price seen: median <strong>${pounds(p.firstPrice.median)}</strong>, from ${pounds(p.firstPrice.min)} to ${pounds(p.firstPrice.max)} (${plural(p.n, 'day', 'days')}).${thin(p.n)}</p>`);
      parts.push(`<p class="stat-line"><strong>${p.withChange} of ${p.n}</strong> days (${pct(p.withChange, p.n)}) changed price after tickets appeared. A drop at some point on ${p.anyDrop} (${pct(p.anyDrop, p.n)}), a rise on ${p.anyRise} (${pct(p.anyRise, p.n)}).</p>`);
      parts.push(`<p class="stat-line">By the last look, ${p.netLower} were cheaper than their first price, ${p.netHigher} dearer, and ${p.n - p.netLower - p.netHigher} the same.${p.withChange ? ` Among the ones that changed, the typical net change was ${signed(p.medianNetChange)}, first coming a median of ${p.hoursToFirstChange.median} hours after tickets appeared.` : ''}</p>`);
      if (p.biggestDrop) parts.push(`<p class="stat-line">Biggest drop: ${esc(dayLabel(p.biggestDrop.date))}, ${pounds(p.biggestDrop.from)} to ${pounds(p.biggestDrop.to)}.</p>`);
    }
    parts.push('</div></div>');

    const l = r.lasts;
    parts.push('<h3 class="stat-head">How long tickets last</h3><div class="event-card"><div class="event-main">');
    parts.push(`<p class="stat-line">${plural(l.goneEarly, 'day', 'days')} ${l.goneEarly === 1 ? 'has' : 'have'} gone with more than 1 day to travel (sold out), and ${l.goneLate} within a day of travel (sold out or the sale simply closed). ${l.returns ? `Tickets came back on ${plural(l.returns, 'occasion', 'occasions')}. ` : ''}${l.hours.n ? `Tickets that went lasted a median of <strong>${l.hours.median} hours</strong> (${plural(l.hours.n, 'day', 'days')}).${thin(l.hours.n)}` : 'No ticket has gone since it appeared, so there is no length of time yet.'}</p>`);
    parts.push('</div></div>');

    const rows = r.byWeekday.filter((w) => w.dates).map((w) => `<div class="owner-row"><div class="owner-row-main"><span class="owner-row-title">${w.name}</span><div class="owner-row-sub">${plural(w.dates, 'date', 'dates')} · ${w.n ? `appear a median ${w.medianLead} days ahead` : 'no appearance seen'} · first price ${w.medianFirstPrice === null ? 'n/a' : `median ${pounds(w.medianFirstPrice)}`}</div></div></div>`);
    if (rows.length) parts.push(`<h3 class="stat-head">By travel day</h3><div class="owner-list">${rows.join('')}</div>`);
    return parts.join('');
  }

  // The comparison, in plain words: only says "X is ..." when both directions have enough days.
  function compareHtml(stats) {
    const c = compare(stats);
    const t = c.timing;
    const p = c.price;
    const ch = c.changes;
    const A = ROUTE_NAMES[A_ID];
    const B = ROUTE_NAMES[B_ID];
    const cell = (v) => `<span class="cmp-cell">${v}</span>`;
    const row = (label, x, y) => `<div class="cmp-row"><span class="cmp-label">${label}</span>${cell(x)}${cell(y)}</div>`;
    const lead = (d) => (d.n ? `${d.median} days ahead <small>(${plural(d.n, 'date', 'dates')})</small>` : 'none seen yet');
    const hr = (d) => (d.n ? `${hourLabel(d.hourMode)}` : 'n/a');
    const price = (d) => (d.n ? `${pounds(d.median)} <small>(${plural(d.n, 'date', 'dates')})</small>` : 'none seen yet');
    const changed = (d) => (d.n ? `${d.withChange} of ${d.n} <small>(${pct(d.withChange, d.n)})</small>` : 'n/a');
    const dropped = (d) => (d.n ? `${d.anyDrop} of ${d.n} <small>(${pct(d.anyDrop, d.n)})</small>` : 'n/a');

    const verdict = (text) => `<p class="stat-line stat-verdict">${text}</p>`;
    const early = (what) => `Too early to tell ${what}. It needs ${THIN}+ dates in each direction.`;

    const timingVerdict = !t.enough
      ? early('which direction appears earlier')
      : t.leadDiff === 0 || Math.abs(t.leadDiff) < 1 ? 'No clear difference in how early tickets appear.'
        : `${t.leadDiff > 0 ? B : A} tends to appear about ${Math.abs(t.leadDiff)} ${Math.abs(t.leadDiff) === 1 ? 'day' : 'days'} earlier.`;
    const pairedTiming = t.paired.n
      ? `On the ${plural(t.paired.n, 'date', 'dates')} that appeared in both directions, ${A} came first on ${t.paired.aEarlier}, ${B} on ${t.paired.bEarlier}, and they appeared within an hour of each other on ${t.paired.sameTime}${t.paired.n >= 1 ? ` (median gap ${Math.abs(t.paired.medianGapHours)} hours${t.paired.medianGapHours > 0 ? `, ${A} first` : t.paired.medianGapHours < 0 ? `, ${B} first` : ''})` : ''}.${thin(t.paired.n)}`
      : 'No date has appeared in both directions yet.';

    let priceVerdict;
    if (!p.enough) priceVerdict = `Too early to tell which direction is cheaper. It needs ${THIN}+ travel dates priced in both (so far ${p.paired.n}).`;
    else {
      const most = Math.max(p.paired.aCheaper, p.paired.bCheaper);
      priceVerdict = most / p.paired.n >= 0.7
        ? `${p.paired.bCheaper > p.paired.aCheaper ? B : A} is usually cheaper: ${most} of ${p.paired.n} dates, by a median of ${pounds(Math.abs(p.paired.medianDiff))}.`
        : 'No clear difference in price between the two directions.';
    }
    const pairedPrice = p.paired.n
      ? `On the ${plural(p.paired.n, 'date', 'dates')} priced in both directions, ${B} was cheaper on ${p.paired.bCheaper}, ${A} on ${p.paired.aCheaper}, and they were equal on ${p.paired.equal}.${thin(p.paired.n)}`
      : 'No date has been priced in both directions yet.';

    const changeVerdict = !ch.enough
      ? early('which direction changes price more often')
      : Math.abs(ch.shareDiff) < 15 ? 'No clear difference in how often prices change.'
        : `Prices change more often in ${ch.shareDiff > 0 ? B : A} (${Math.abs(ch.shareDiff)} percentage points more).`;

    return `<h2 class="section-title">Direction comparison</h2>
      <div class="event-card"><div class="event-main">
        <div class="cmp-grid">
          <div class="cmp-row cmp-head"><span class="cmp-label"></span>${cell(A)}${cell(B)}</div>
          ${row('Tickets appear', lead(t.a), lead(t.b))}
          ${row('Most common hour', hr(t.a), hr(t.b))}
          ${row('First price (median)', price(p.a), price(p.b))}
          ${row('Changed price after appearing', changed(ch.a), changed(ch.b))}
          ${row('Dropped at some point', dropped(ch.a), dropped(ch.b))}
        </div>
        <h3 class="stat-head">When tickets appear</h3>${verdict(timingVerdict)}<p class="stat-line">${pairedTiming}</p>
        <h3 class="stat-head">Price level</h3>${verdict(priceVerdict)}<p class="stat-line">${pairedPrice}</p>
        <h3 class="stat-head">Price changes</h3>${verdict(changeVerdict)}
      </div></div>`;
  }

  // The estimate for one travel date, one card per direction. Run again whenever the date changes.
  function estimateCard(id, e, date, todayIso) {
    const name = ROUTE_NAMES[id];
    const parts = [];
    if (e.kind === 'thin') {
      parts.push(`<p class="stat-line">Not enough data yet: ${plural(e.n, 'date has', 'dates have')} gone from "not on sale" to "on sale" so far, and it needs ${MIN_FOR_ESTIMATE}.</p>`);
    } else {
      const state = e.status === 'on' ? `<strong>On sale now</strong>${e.price !== null ? ` (from ${pounds(e.price)})` : ''}.`
        : e.status === 'gone' ? '<strong>Tickets for this date have gone</strong> (sold out or the sale closed).'
          : e.status === 'not-yet' ? (e.usualDate > todayIso ? '<strong>Not on sale yet.</strong>' : e.byDate < todayIso ? '<strong>Not on sale yet, and later than usual</strong>: about 90% of dates had tickets by now.' : '<strong>Not on sale yet, but due about now.</strong>')
            : e.daysAway > WATCHED_DAYS ? `<strong>${e.daysAway} days away is further ahead than we watch</strong> (${WATCHED_DAYS} days), so this is only the usual pattern.`
              : '<strong>No record for this date</strong> (collection began after it came into view), so this is only the usual pattern.';
      parts.push(`<p class="stat-line">${state}</p>`);
      parts.push(`<p class="stat-line">Tickets usually appear about <strong>${e.typical} days before travel</strong>, which for ${esc(dayLabel(date))} is around <strong>${esc(dayLabel(e.usualDate))}</strong>${e.range[0] === e.range[1] ? '' : `, within ${esc(dayLabel(e.earliest))} to ${esc(dayLabel(e.latest))}`}. About 90% of dates had them by ${e.byLead} days before travel (${esc(dayLabel(e.byDate))}), most often at ${hourLabel(e.hourMode)} London time (${e.hourCount} of ${e.hourN}).</p>`);
      const c = e.confidence;
      parts.push(`<p class="stat-line"><span class="conf conf-${c.level.toLowerCase()}">Confidence: ${c.level}</span> Based on ${plural(c.n, 'date', 'dates')}; ${Math.round(100 * c.within1)}% within a day of the typical ${e.typical} days, range ${e.range[0]}${e.range[0] === e.range[1] ? '' : `–${e.range[1]}`} days.${c.level === 'Low' ? (c.n < THIN ? ' Few dates so far.' : ' The timing varies a lot.') : ''}</p>`);
    }
    return `<div class="event-card"><div class="event-main"><p class="event-name">${esc(name)}</p>${parts.join('')}</div></div>`;
  }

  function estimateHtml(stats, date, todayIso) {
    if (!ISO_DATE.test(date || '')) return '<p class="hint">Pick a travel date above.</p>';
    if (date < todayIso) return '<p class="hint">That date has already gone. Pick one in the future.</p>';
    return Object.keys(ROUTE_NAMES).map((id) => estimateCard(id, estimate(stats.routes[id], date, todayIso), date, todayIso)).join('');
  }

  function estimateShell() {
    return `<h2 class="section-title">When will tickets appear for my date?</h2>
      <p class="hint">Pick the travel date you want. This uses every date seen so far and updates as more data comes in.</p>
      <label class="city-pick" for="est-date">Travel date <input type="date" id="est-date" class="owner-input" aria-label="Travel date to estimate" /></label>
      <div id="est-body"></div>`;
  }

  function html(stats) {
    const out = [];
    const notes = [];
    if (stats.capped) notes.push('The log is full, so nothing new is being recorded. Tell Claude to archive it.');
    if (Object.keys(stats.blocked).length) notes.push(`Snap is not answering for ${Object.keys(stats.blocked).map((r) => ROUTE_NAMES[r]).join(' and ')} right now, so those days are not being updated.`);
    if (stats.hoursSinceCheck !== null && stats.hoursSinceCheck > 7) notes.push(`The last check was ${Math.round(stats.hoursSinceCheck)} hours ago, so the hourly job may have stopped.`);
    out.push(`<p class="subtitle">Collecting since ${stats.since ? esc(londonFmt({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms(stats.since)))) : 'not yet'} · ${stats.daysCollected} days · ${plural(stats.events, 'change', 'changes')} logged · ${stats.gapHours} hours Snap did not answer</p>`);
    for (const n of notes) out.push(`<p class="form-msg error">${esc(n)}</p>`);
    out.push('<p class="hint">Cheapest price per day, checked every hour. Every figure shows how many days it is based on; a few weeks is a small sample, and one month before Christmas may not match the rest of the year.</p>');
    out.push(compareHtml(stats));
    out.push(estimateShell());
    for (const id of Object.keys(ROUTE_NAMES)) out.push(routeHtml(id, stats.routes[id]));
    return out.join('');
  }

  const api = { analyse, html, estimate, estimateHtml, compare, confidenceFor, median, mode, ROUTE_NAMES, THIN, MIN_FOR_ESTIMATE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SnapStats = api;
})(typeof window !== 'undefined' ? window : globalThis);
