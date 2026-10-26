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

    return {
      tracked: lives.length,
      notOnSaleYet: lives.filter((l) => !l.onSale && !l.goneAt && !l.prices.length).length,
      alreadyOnSale: lives.filter((l) => l.alreadyOnSale).length,
      appear: { lead: { ...summary(lead), mode: mode(lead), histogram: histogram(lead) }, hour: { n: hours.length, mode: mode(hours), median: median(hours), histogram: histogram(hours) } },
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

  function html(stats) {
    const out = [];
    const notes = [];
    if (stats.capped) notes.push('The log is full, so nothing new is being recorded. Tell Claude to archive it.');
    if (Object.keys(stats.blocked).length) notes.push(`Snap is not answering for ${Object.keys(stats.blocked).map((r) => ROUTE_NAMES[r]).join(' and ')} right now, so those days are not being updated.`);
    if (stats.hoursSinceCheck !== null && stats.hoursSinceCheck > 7) notes.push(`The last check was ${Math.round(stats.hoursSinceCheck)} hours ago, so the hourly job may have stopped.`);
    out.push(`<p class="subtitle">Collecting since ${stats.since ? esc(londonFmt({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms(stats.since)))) : 'not yet'} · ${stats.daysCollected} days · ${plural(stats.events, 'change', 'changes')} logged · ${stats.gapHours} hours Snap did not answer</p>`);
    for (const n of notes) out.push(`<p class="form-msg error">${esc(n)}</p>`);
    out.push('<p class="hint">Cheapest price per day, checked every hour. Every figure shows how many days it is based on; a few weeks is a small sample, and one month before Christmas may not match the rest of the year.</p>');
    for (const id of Object.keys(ROUTE_NAMES)) out.push(routeHtml(id, stats.routes[id]));
    return out.join('');
  }

  const api = { analyse, html, median, mode, ROUTE_NAMES, THIN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SnapStats = api;
})(typeof window !== 'undefined' ? window : globalThis);
