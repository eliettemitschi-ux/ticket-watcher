// Pure parsing of Barbican's /whats-on listing HTML. The listing is grouped
// by day (<div data-day="Fri 2 Oct"> wrapping one <article> per event), so
// a multi-date show appears once per date -- counting those appearances is
// how the scanner learns a show's run length before it's even on sale.

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} html one listing page
 * @returns {{day:string, href:string, nodeId:string|null, title:string, tags:string[], text:string}[]}
 */
function parseListing(html) {
  const cards = [];
  for (const chunk of String(html).split('<div data-day="').slice(1)) {
    const day = chunk.slice(0, chunk.indexOf('"'));
    for (const article of chunk.split('<article class="listing--event').slice(1)) {
      const href = (/search-listing__link"\s+href="(\/whats-on\/\d{4}\/event\/[^"]+)"/.exec(article) || [])[1];
      if (!href) continue;
      const title = stripTags((/<h2[^>]*class="listing-title[^"]*"[^>]*>([\s\S]*?)<\/h2>/.exec(article) || [])[1] || '');
      const tags = [...article.matchAll(/class="tag__plain">([^<]+)</g)].map((m) => decodeEntities(m[1]).trim());
      const nodeId = (/data-saved-event-id="(\d+)"/.exec(article) || [])[1] || null;
      const intro = (/search-listing__intro">([\s\S]*?)<div class="search-listing__accordion/.exec(article) || [])[1] || '';
      cards.push({ day, href, nodeId, title, tags, text: stripTags(intro) });
    }
  }
  return cards;
}

// Collapses per-day cards into one record per event (keyed by href), with
// the list of distinct days it runs on.
function groupByEvent(cards) {
  const events = new Map();
  for (const c of cards) {
    const existing = events.get(c.href);
    if (!existing) {
      events.set(c.href, { href: c.href, nodeId: c.nodeId, title: c.title, tags: c.tags, text: c.text, days: [c.day] });
    } else if (!existing.days.includes(c.day)) {
      existing.days.push(c.day);
    }
  }
  return events;
}

function hasLoadMore(html) {
  return /<span>Load More<\/span>/i.test(String(html));
}

module.exports = { parseListing, groupByEvent, hasLoadMore, decodeEntities, stripTags };
