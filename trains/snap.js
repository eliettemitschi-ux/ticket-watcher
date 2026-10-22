// Eurostar Snap from Node: the page reading lives in snapParse.js (shared with
// the Cloudflare Worker); this adds the network fetch.

const fetch = require('node-fetch');
const { HEADERS, MONTHS, searchUrl, addDays, parseSearchHtml } = require('./snapParse');

/** @returns {Promise<{status:number, parsed:object|null}>} */
async function fetchSearch(route, dateIso) {
  const res = await fetch(searchUrl(route, dateIso), { headers: HEADERS, timeout: 25000 });
  const html = await res.text();
  return { status: res.status, parsed: res.ok ? parseSearchHtml(html, dateIso) : null };
}

module.exports = { searchUrl, parseSearchHtml, fetchSearch, addDays, MONTHS };
