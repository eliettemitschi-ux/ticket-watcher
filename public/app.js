// app.js -- vanilla JS, no build step. Polls /api/events every 30s and
// re-renders the list; talks to the same API the CLI scripts use.

const STATE_LABELS = {
  available: 'Choose seat',
  sold_out: 'Fully booked',
  pending: 'Checking…',
  unknown: 'Unknown',
  error: 'Check failed',
};

// Every button click below goes through this instead of a bare fetch().
// Without a client-side timeout, a genuinely hung request (a stuck
// browser launch on the server, a flaky local network stack, etc.) would
// leave a button reading "Checking…" forever with no way to tell
// something's wrong -- exactly what happened before this was added.
async function fetchWithTimeout(url, options = {}, ms = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Filled in by loadStatusLine() once /api/status has answered; defaults
// to the same fallback used everywhere else in this codebase so a card
// rendered before that first response still gets a working link.
let ntfyServer = 'https://ntfy.sh';

function eventCard(event) {
  const state = event.status?.state || 'unknown';
  const label = STATE_LABELS[state] || state;
  const checkedText = timeAgo(event.status?.lastChecked);
  const errorLine = event.status?.lastError
    ? `<div class="event-meta" style="color:var(--sold-out)">Last error: ${escapeHtml(event.status.lastError)}</div>`
    : '';
  const subscribeLink = event.ntfyTopic
    ? `<a class="event-subscribe" href="${ntfyServer}/${encodeURIComponent(event.ntfyTopic)}" target="_blank" rel="noopener">🔔 Notify me for just this show</a>`
    : '';

  return `
    <div class="event-card" data-id="${event.id}">
      <div class="event-main">
        <p class="event-name"><a href="${event.url}" target="_blank" rel="noopener">${escapeHtml(event.name)}</a></p>
        ${event.venue ? `<p class="event-venue">${escapeHtml(event.venue)}</p>` : ''}
        <span class="badge ${state}">${label}</span>
        <div class="event-meta">
          Checked ${checkedText} · mode: ${event.recipe?.mode || 'render'}
        </div>
        ${errorLine}
        ${subscribeLink}
      </div>
      <div class="event-actions">
        <button data-action="check" data-id="${event.id}">Recheck now</button>
        <button data-action="delete" data-id="${event.id}" class="danger">Remove</button>
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadEvents() {
  const res = await fetch('/api/events');
  const events = await res.json();
  const container = document.getElementById('events');
  container.innerHTML = events.length
    ? events.map(eventCard).join('')
    : '<div class="empty-state">No events yet — add one below.</div>';
}

async function loadStatusLine() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    const channels = [];
    if (data.notifications.ntfy) channels.push('push (ntfy)');
    if (data.notifications.email) channels.push('email');
    const subtitle = document.getElementById('subtitle');
    subtitle.textContent = channels.length
      ? `Checking every ~${data.pollIntervalMinutes} min · notifying via ${channels.join(' & ')}`
      : `Checking every ~${data.pollIntervalMinutes} min · no notification channel configured yet (see .env)`;

    if (data.ntfy?.server) ntfyServer = data.ntfy.server;

    // Only present on the viewer page (index.html) -- the "Get notified
    // yourself" section that tells people which ntfy topic to subscribe to.
    const topicEl = document.getElementById('ntfy-topic');
    const webLinkEl = document.getElementById('ntfy-web-link');
    if (topicEl) {
      topicEl.textContent = data.ntfy ? data.ntfy.topic : 'not configured yet';
    }
    if (webLinkEl && data.ntfy) {
      const url = `${data.ntfy.server}/${encodeURIComponent(data.ntfy.topic)}`;
      webLinkEl.href = url;
      webLinkEl.textContent = url;
    }
  } catch {
    /* non-critical */
  }
}

document.getElementById('events').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = action === 'check' ? 'Checking…' : 'Removing…';

  try {
    if (action === 'check') {
      await fetchWithTimeout(`/api/events/${id}/check`, { method: 'POST' }, 60000);
    } else if (action === 'delete') {
      if (!confirm('Remove this event from the watch list?')) {
        btn.disabled = false;
        btn.textContent = originalText;
        return;
      }
      await fetchWithTimeout(`/api/events/${id}`, { method: 'DELETE' }, 60000);
    }
  } catch (err) {
    alert(
      err.name === 'AbortError'
        ? 'That took over a minute with no response -- something is stuck server-side. Check the terminal window running node server.js for details.'
        : `Something went wrong: ${err.message}`
    );
  } finally {
    await loadEvents();
  }
});

// Only present on the admin page (admin.html) -- the viewer page
// (index.html) doesn't have an add-event form at all.
document.getElementById('add-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const hint = document.getElementById('add-hint');
  const submitBtn = form.querySelector('button[type="submit"]');
  const data = Object.fromEntries(new FormData(form).entries());

  submitBtn.disabled = true;
  hint.className = 'hint';
  hint.textContent = 'Loading the page and checking availability — this takes a few seconds…';

  try {
    const res = await fetchWithTimeout(
      '/api/events',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      },
      70000
    );
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Something went wrong.');

    hint.className = 'hint success';
    hint.textContent = `Added. Current status: ${STATE_LABELS[body.status.state] || body.status.state}.`;
    form.reset();
    await loadEvents();
  } catch (err) {
    hint.className = 'hint error';
    hint.textContent =
      err.name === 'AbortError'
        ? 'That took over a minute with no response -- something is stuck server-side. Check the terminal window running node server.js for details.'
        : err.message;
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById('test-notify-btn').addEventListener('click', async () => {
  const btn = document.getElementById('test-notify-btn');
  const hint = document.getElementById('test-notify-hint');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Sending…';
  hint.className = 'hint';
  hint.textContent = '';

  try {
    const res = await fetchWithTimeout('/api/test-notify', { method: 'POST' }, 20000);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Something went wrong.');

    const parts = [];
    if (body.ntfy) parts.push(body.ntfy.sent ? 'push: sent' : body.ntfy.skipped ? 'push: not configured' : `push failed: ${body.ntfy.error}`);
    if (body.email) parts.push(body.email.sent ? 'email: sent' : body.email.skipped ? 'email: not configured' : `email failed: ${body.email.error}`);

    const anyFailed = [body.ntfy, body.email].some((r) => r && r.error);
    hint.className = anyFailed ? 'hint error' : 'hint success';
    hint.textContent = parts.join(' · ') || 'Nothing to report.';
  } catch (err) {
    hint.className = 'hint error';
    hint.textContent =
      err.name === 'AbortError' ? "That took over 20s with no response -- check the terminal window." : err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

loadEvents();
loadStatusLine();
setInterval(loadEvents, 30000);
