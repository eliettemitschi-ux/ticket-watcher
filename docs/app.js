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
  let allEvents;
  try {
    const res = await fetch('./events.json', { cache: 'no-store' });
    allEvents = await res.json();
  } catch {
    return; // offline or a blip: leave whatever is already on screen
  }
  // Archived (tickets already secured) is a personal record kept in the
  // data file, not something worth showing on the shared page.
  const events = allEvents.filter((e) => !e.archived);
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

// --- Installable app + settings ------------------------------------------

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* installing as an app is a nicety; the page works without it */
  });
}

const offlineNote = document.getElementById('offline-note');
function syncOffline() {
  if (offlineNote) offlineNote.hidden = navigator.onLine;
}
window.addEventListener('online', () => {
  syncOffline();
  loadEvents();
  loadStatusLine();
});
window.addEventListener('offline', syncOffline);
syncOffline();

function detectPlatform() {
  const ua = navigator.userAgent || '';
  // iPadOS 13+ identifies as a Mac but has a touch screen.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

function isInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

let deferredInstallPrompt = null;
const settingsDialog = document.getElementById('settings-dialog');
const installBtn = document.getElementById('install-btn');
const installStatus = document.getElementById('install-status');

function renderInstallState() {
  if (!settingsDialog) return;
  const platform = detectPlatform();
  if (isInstalled()) {
    installStatus.textContent = "✅ You're already using the installed app.";
  } else if (deferredInstallPrompt) {
    installStatus.textContent = 'Your browser can install this with one tap:';
  } else {
    installStatus.textContent = 'Follow the steps for your device below.';
  }
  installBtn.hidden = !deferredInstallPrompt || isInstalled();
  // Open the section that matches this device; leave the others closed.
  for (const id of ['ios', 'android', 'desktop']) {
    const el = document.getElementById(`install-${id}`);
    if (el) el.open = id === platform;
  }
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  renderInstallState();
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  if (installStatus) installStatus.textContent = '✅ Installed. Look for the icon on your home screen.';
  if (installBtn) installBtn.hidden = true;
});

if (installBtn) {
  installBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice.catch(() => {});
    deferredInstallPrompt = null;
    renderInstallState();
  });
}

const settingsBtn = document.getElementById('settings-btn');
if (settingsBtn && settingsDialog) {
  settingsBtn.addEventListener('click', () => {
    renderInstallState();
    if (typeof settingsDialog.showModal === 'function') settingsDialog.showModal();
    else settingsDialog.setAttribute('open', '');
  });
  // Tapping the dimmed area outside the panel closes it.
  settingsDialog.addEventListener('click', (event) => {
    if (event.target === settingsDialog) settingsDialog.close();
  });
}

// --- Owner access ----------------------------------------------------------
// A private extra tab, invisible to everyone else. It loads only when this
// device already holds the owner's token, when the address ends in #owner, or
// after five quick taps on the Settings heading.

function loadOwner(askForToken) {
  const start = () => window.TWOwner.start({ prompt: askForToken });
  if (window.TWOwner) {
    start();
    return;
  }
  const script = document.createElement('script');
  script.src = './owner.js';
  script.onload = start;
  document.head.appendChild(script);
}

let hasOwnerToken = false;
try {
  hasOwnerToken = Boolean(localStorage.getItem('twOwnerToken'));
} catch {
  /* storage unavailable (private browsing) */
}
if (hasOwnerToken) loadOwner(false);
if (location.hash === '#owner') loadOwner(true);

// A plain, always-works way in: a small "Owner sign-in" link at the bottom of
// Settings. Anyone can tap it, but without the owner's token it unlocks nothing.
const ownerSignin = document.getElementById('owner-signin');
if (ownerSignin && settingsDialog) {
  ownerSignin.addEventListener('click', () => {
    settingsDialog.close();
    loadOwner(true);
  });
}

const settingsTitle = document.getElementById('settings-title');
if (settingsTitle && settingsDialog) {
  let taps = 0;
  let tapTimer = null;
  settingsTitle.addEventListener('click', () => {
    taps += 1;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { taps = 0; }, 2500);
    if (taps >= 5) {
      taps = 0;
      settingsDialog.close();
      loadOwner(true);
    }
  });
}
