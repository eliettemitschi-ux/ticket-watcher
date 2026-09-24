// docs/app.js -- static-dashboard version. No backend here: this page is
// served by GitHub Pages as plain static files, so it just fetches the
// JSON file the GitHub Actions check workflow commits after every run
// (events.json, right next to this page) and status.json (a tiny file
// the workflow also writes, since there's no live /api/status to ask).
// Read-only by design -- no add/recheck/remove buttons, since there's no
// server here to act on them. See HANDOFF.md for why (this is the free,
// GitHub Actions-hosted deployment; adding events happens via the
// separate "Add Barbican event" GitHub Actions workflow instead of a
// form on this page).

const STATE_LABELS = {
  available: 'Choose seat',
  sold_out: 'Fully booked',
  pending: 'Checking…',
  unknown: 'Unknown',
  error: 'Check failed',
};

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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Filled in by loadStatusLine() once status.json has answered; defaults
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
        <div class="event-meta">Checked ${checkedText}</div>
        ${errorLine}
        ${subscribeLink}
      </div>
    </div>
  `;
}

async function loadEvents() {
  const res = await fetch('./events.json', { cache: 'no-store' });
  const events = await res.json();
  const container = document.getElementById('events');
  container.innerHTML = events.length
    ? events.map(eventCard).join('')
    : '<div class="empty-state">No events watched right now.</div>';
}

async function loadStatusLine() {
  try {
    const res = await fetch('./status.json', { cache: 'no-store' });
    const data = await res.json();
    const subtitle = document.getElementById('subtitle');
    subtitle.textContent = `Checking every ~${data.pollIntervalMinutes} min · notifying via push (ntfy)`;

    if (data.ntfy?.server) ntfyServer = data.ntfy.server;

    const topicEl = document.getElementById('ntfy-topic');
    const webLinkEl = document.getElementById('ntfy-web-link');
    if (topicEl) topicEl.textContent = data.ntfy ? data.ntfy.topic : 'not configured yet';
    if (webLinkEl && data.ntfy) {
      const url = `${data.ntfy.server}/${encodeURIComponent(data.ntfy.topic)}`;
      webLinkEl.href = url;
      webLinkEl.textContent = url;
    }
  } catch {
    /* non-critical */
  }
}

loadEvents();
loadStatusLine();
setInterval(loadEvents, 30000);
