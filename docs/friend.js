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

  // "Pierre Express": the page title for a friend, or the plain title when there is no name.
  const titleFor = (name) => (name ? `${name} Express` : 'Snap train alerts');

  // "You can watch up to 4 dates at once (1 used)."
  function capLine(data) {
    const used = (data.trips || []).reduce((n, t) => n + [...(t.out || []), ...(t.back || [])].filter((d) => d >= data.today).length, 0);
    return `You can watch up to ${data.maxDates} dates at once (${used} used).`;
  }

  function statusLine(data) {
    if (data.blocked) return '⚠️ Eurostar is refusing checks right now, so alerts may be late.';
    return `Alerts go to ${data.topic} · checks every 5 minutes`;
  }

  const helpers = { escapeHtml, addDateTo, seenBadge, tripCard, statusLine, fmtDate, titleFor, capLine };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (typeof document === 'undefined') return;

  // --- Browser-only ---------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const draft = { out: [], back: [] };
  let data = null;
  let busy = false; // a save or removal is in flight

  const getKey = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const setKey = (k) => { try { localStorage.setItem(KEY, k); } catch { /* private mode */ } };
  const londonToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

  let sessionKey = null;

  const TIMEOUT_MS = 25000;

  async function call(method, { query = '', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${API}${query}`, {
        method,
        headers: { Authorization: `Bearer ${sessionKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(err && err.name === 'AbortError'
        ? 'That took too long. Check your connection and try again.'
        : "Couldn't reach the server. Check your connection and try again.");
    } finally {
      clearTimeout(timer);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || `Error ${res.status}`), { status: res.status });
    return json;
  }

  // Messages sit right under the button that caused them ('msg' under Start
  // watching, 'trips-msg' under the Watching heading), so they are never off-screen.
  function setMessage(text, kind, where) {
    const el = $(where || 'msg');
    el.textContent = text || '';
    el.className = `form-msg${kind ? ` ${kind}` : ''}`;
  }

  function render() {
    const today = (data && data.today) || londonToday();
    for (const leg of ['out', 'back']) {
      $(`${leg}-date`).min = today;
      $(`${leg}-chips`).innerHTML = draft[leg]
        .map((d) => `<button type="button" class="chip active" data-unadd-${leg}="${d}" aria-label="Remove ${fmtDate(d)}">${fmtDate(d)} ✕</button>`)
        .join('');
    }
    const hasDraft = draft.out.length + draft.back.length > 0;
    $('save').disabled = busy || !hasDraft;
    $('save').textContent = busy ? 'Saving…' : 'Start watching';
    $('pending-note').hidden = busy || !hasDraft;
    if (!data) return;
    $('personal-note').hidden = !data.note;
    $('passport-note').hidden = !data.passport;
    $('cap-note').textContent = capLine(data);
    if (data.name) {
      $('title').textContent = titleFor(data.name);
      document.title = titleFor(data.name);
    }
    $('status').textContent = statusLine(data);
    document.querySelectorAll('.topic-name').forEach((el) => { el.textContent = data.topic; });
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
    if (busy) return; // never fight with a save in progress
    try {
      const fresh = await call('GET');
      if (busy) return; // a save started while this was loading: its answer is newer
      data = fresh;
    } catch (err) {
      if (err.status === 401) { try { localStorage.removeItem(KEY); } catch { /* ignore */ } badLink(); return; }
      // A failed background refresh keeps the last data quietly, unless there is none yet.
      if (!data) setMessage(err.message, 'error');
    }
    render();
  }

  async function onClick(event) {
    const btn = event.target.closest('button');
    if (!btn) return;
    if (btn.dataset.add) {
      const input = $(`${btn.dataset.add}-date`);
      if (!input.value) { setMessage('Pick a date first, then tap + Add date.', 'error'); return; }
      if (input.value < ((data && data.today) || londonToday())) { setMessage('That date has already gone.', 'error'); return; }
      draft[btn.dataset.add] = addDateTo(draft[btn.dataset.add], input.value);
      input.value = '';
      setMessage('', '');
    } else if (btn.dataset.unaddOut || btn.dataset.unaddBack) {
      const leg = btn.dataset.unaddOut ? 'out' : 'back';
      draft[leg] = draft[leg].filter((d) => d !== (btn.dataset.unaddOut || btn.dataset.unaddBack));
    } else if (btn.id === 'save') {
      if (busy) return;
      busy = true;
      setMessage('Saving your dates…', '');
      render();
      try {
        data = await call('POST', { body: { out: draft.out, back: draft.back } });
        draft.out = [];
        draft.back = [];
        setMessage('Saved. You are now watching these dates. The first check runs within about 5 minutes.', 'ok');
      } catch (err) {
        setMessage(`Not saved: ${err.message}`, 'error');
      } finally {
        busy = false;
      }
    } else if (btn.dataset.remove) {
      if (busy) return;
      busy = true;
      setMessage('Stopping…', '', 'trips-msg');
      render();
      try {
        data = await call('DELETE', { query: `?id=${encodeURIComponent(btn.dataset.remove)}` });
        setMessage('Stopped watching that trip.', 'ok', 'trips-msg');
      } catch (err) {
        setMessage(`Not removed: ${err.message}`, 'error', 'trips-msg');
      } finally {
        busy = false;
      }
    } else {
      return;
    }
    render();
  }

  // Copies the channel name; falls back to selecting it where the clipboard is blocked.
  function onCopy() {
    const el = document.querySelector('.topic-name');
    const done = (text) => { $('copied').textContent = text; };
    const select = () => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      done('Selected. Press copy.');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(el.textContent).then(() => done('Copied'), select);
    else select();
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
    $('copy-topic').addEventListener('click', onCopy);
    render();
    refresh();
    setInterval(refresh, 60000);
  }

  start();
})(typeof window !== 'undefined' ? window : globalThis);
