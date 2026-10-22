// docs/friend.js -- the friend page: add and remove your own Snap dates.
//
// There is nothing private in this file. You open a personal link that carries
// a key (friend.html#key=...); the key is kept on this device, removed from the
// address bar, and sent to the Worker, which only lets it touch its own
// channel's trips (cron-worker/src/friend.js).

(function (root) {
  'use strict';

  const API = 'https://ticket-watcher-cron.eliettemitschi.workers.dev/friend';
  const KEY = 'twFriendKey';
  const TZ = 'Europe/London';

  // --- Pure helpers (unit tested in test/friend.test.js) ----------------------

  const escapeHtml = (str) => String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${iso}T12:00:00Z`));

  function addDateTo(dates, date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return dates;
    return Array.from(new Set([...dates, date])).sort();
  }

  function seenBadge(seen) {
    if (!seen || seen.state === 'unknown') return '<span class="badge unknown">Not checked yet</span>';
    if (seen.state === 'none') return '<span class="badge pending">No Snap tickets yet</span>';
    return `<span class="badge available">From £${escapeHtml(seen.price)}</span>`;
  }

  function tripCard(trip, today) {
    const leg = (name, label) => {
      const dates = trip[name] || [];
      if (!dates.length) return '';
      const lines = dates.map((d) => (d < today
        ? `<div class="event-meta trip-past">${fmtDate(d)} · gone</div>`
        : `<div class="event-meta">${fmtDate(d)} ${seenBadge(trip.seen && trip.seen[name] && trip.seen[name][d])}</div>`)).join('');
      return `<p class="event-venue trip-leg">${label}</p>${lines}`;
    };
    return `
      <div class="event-card">
        <div class="event-main">
          ${leg('out', 'London → Paris')}
          ${leg('back', 'Paris → London')}
          <button type="button" class="settings-btn trip-remove" data-remove="${escapeHtml(trip.id)}">Stop watching</button>
        </div>
      </div>`;
  }

  function statusLine(data) {
    if (data.blocked) return '⚠️ Eurostar is refusing checks right now, so alerts may be late.';
    return `Alerts go to ${data.topic} · checks every 5 minutes`;
  }

  const helpers = { escapeHtml, addDateTo, seenBadge, tripCard, statusLine, fmtDate };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (typeof document === 'undefined') return;

  // --- Browser-only ---------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const draft = { out: [], back: [] };
  let data = null;

  const getKey = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const setKey = (k) => { try { localStorage.setItem(KEY, k); } catch { /* private mode */ } };
  const londonToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

  let sessionKey = null;

  async function call(method, { query = '', body } = {}) {
    const res = await fetch(`${API}${query}`, {
      method,
      headers: { Authorization: `Bearer ${sessionKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || `Error ${res.status}`), { status: res.status });
    return json;
  }

  function setMessage(text, isError) {
    $('msg').textContent = text || '';
    $('msg').className = `hint${isError ? ' error' : ''}`;
  }

  function render() {
    const today = (data && data.today) || londonToday();
    for (const leg of ['out', 'back']) {
      $(`${leg}-date`).min = today;
      $(`${leg}-chips`).innerHTML = draft[leg]
        .map((d) => `<button type="button" class="chip active" data-unadd-${leg}="${d}" aria-label="Remove ${fmtDate(d)}">${fmtDate(d)} ✕</button>`)
        .join('');
    }
    $('save').disabled = !draft.out.length && !draft.back.length;
    if (!data) return;
    $('status').textContent = statusLine(data);
    $('topic').textContent = data.topic;
    $('count').textContent = `(${data.trips.length})`;
    $('trips').innerHTML = data.trips.length
      ? data.trips.map((t) => tripCard(t, today)).join('')
      : '<div class="empty-state">Nothing watched yet. Add your dates above.</div>';
  }

  function badLink() {
    $('friend-view').hidden = true;
    $('no-key').hidden = false;
    $('status').textContent = 'This link is not valid.';
  }

  async function refresh() {
    try {
      data = await call('GET');
      setMessage('', false);
    } catch (err) {
      if (err.status === 401) { try { localStorage.removeItem(KEY); } catch { /* ignore */ } badLink(); return; }
      setMessage(`Couldn't refresh (${err.message}). Showing the last data.`, true);
    }
    render();
  }

  async function onClick(event) {
    const btn = event.target.closest('button');
    if (!btn) return;
    if (btn.dataset.add) {
      const input = $(`${btn.dataset.add}-date`);
      if (input.value && input.value < ((data && data.today) || londonToday())) { setMessage('That date has already gone.', true); return; }
      draft[btn.dataset.add] = addDateTo(draft[btn.dataset.add], input.value);
      input.value = '';
      setMessage('', false);
    } else if (btn.dataset.unaddOut || btn.dataset.unaddBack) {
      const leg = btn.dataset.unaddOut ? 'out' : 'back';
      draft[leg] = draft[leg].filter((d) => d !== (btn.dataset.unaddOut || btn.dataset.unaddBack));
    } else if (btn.id === 'save') {
      btn.disabled = true;
      setMessage('Saving…', false);
      try {
        data = await call('POST', { body: { out: draft.out, back: draft.back } });
        draft.out = [];
        draft.back = [];
        setMessage('Watching. The first check runs within about 5 minutes.', false);
      } catch (err) {
        setMessage(err.message, true);
      }
    } else if (btn.dataset.remove) {
      setMessage('Saving…', false);
      try {
        data = await call('DELETE', { query: `?id=${encodeURIComponent(btn.dataset.remove)}` });
        setMessage('Stopped watching that trip.', false);
      } catch (err) {
        setMessage(err.message, true);
      }
    } else {
      return;
    }
    render();
  }

  function start() {
    const fromLink = /^#key=([A-Za-z0-9_-]{16,})$/.exec(location.hash);
    if (fromLink) {
      setKey(fromLink[1]);
      sessionKey = fromLink[1];
      history.replaceState(null, '', location.pathname + location.search); // keep the key out of the address bar
    } else {
      sessionKey = getKey();
    }
    if (!sessionKey) { badLink(); return; }
    $('friend-view').hidden = false;
    $('friend-view').addEventListener('click', onClick);
    render();
    refresh();
    setInterval(refresh, 60000);
  }

  start();
})(typeof window !== 'undefined' ? window : globalThis);
