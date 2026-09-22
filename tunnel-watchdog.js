#!/usr/bin/env node
// tunnel-watchdog.js
//
// Keeps the free, account-less Cloudflare "quick tunnel" (the
// `ticket-watcher-tunnel` pm2 process, plain `cloudflared tunnel --url
// http://localhost:3000`) actually reachable, without needing a domain
// (see HANDOFF.md for why a real *.workers.dev-style free URL isn't an
// option for this app -- that naming scheme only exists for things
// deployed AS a Cloudflare Worker).
//
// Real failure mode observed live on 2026-09-22: the tunnel's
// underlying connection died from a network hiccup, and Cloudflare's
// edge then invalidated that specific tunnel session ("Unauthorized:
// Tunnel not found"). cloudflared does NOT recover from this on its
// own -- it just retries the same dead session forever with growing
// backoff. The cloudflared process itself never crashes, so pm2's own
// crash-restart never kicks in either -- the public link just silently
// stays down until a human notices (it sat broken for 40+ minutes
// before anyone did).
//
// Deliberately does NOT spawn or own cloudflared itself -- an earlier
// version of this script did, wrapping it as a child process, but
// cleanly killing a child process tree on a forced/external stop
// (exactly how pm2 itself stops a process) turned out to be unreliable
// on Windows and left an orphaned cloudflared.exe behind in testing.
// Instead, this just tails the SAME log file pm2 already writes for the
// real `ticket-watcher-tunnel` process, and when it sees the dead-
// session signature, shells out to `pm2 restart ticket-watcher-tunnel`
// -- letting pm2 do the actual process management it's already proven
// reliable at in this exact setup, rather than reimplementing it.
//
// Also writes the current public URL to tunnel-url.txt every time a new
// one is issued, so it's a file-read away instead of grepping pm2 logs.

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');

const PM2_TUNNEL_PROCESS = 'ticket-watcher-tunnel';
const LOG_FILE = path.join(os.homedir(), '.pm2', 'logs', `${PM2_TUNNEL_PROCESS}-error.log`);
const URL_FILE = path.join(__dirname, 'tunnel-url.txt');
const POLL_MS = 5000;
// Don't fire a second restart while the last one is still taking effect
// (cloudflared needs a few seconds to spin up a fresh session, during
// which its own startup lines could otherwise look alarming and
// re-trigger this before the new one has had a chance to settle).
const RESTART_COOLDOWN_MS = 60000;

const DEAD_TUNNEL_PATTERNS = [/Unauthorized: Tunnel not found/i, /failed to sufficiently increase receive buffer size/i];
const URL_RE = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i;

let lastPosition = 0;
let lastRestartAt = 0;

function log(...args) {
  console.log(`[${new Date().toISOString()}] [tunnel-watchdog]`, ...args);
}

function restartTunnel(reason) {
  const now = Date.now();
  if (now - lastRestartAt < RESTART_COOLDOWN_MS) {
    return; // already just restarted, give it a moment to settle
  }
  lastRestartAt = now;
  log(`restarting ${PM2_TUNNEL_PROCESS} -- ${reason}`);
  exec(`pm2 restart ${PM2_TUNNEL_PROCESS}`, (err, stdout, stderr) => {
    if (err) log('pm2 restart failed:', err.message, stderr);
    else log('pm2 restart issued successfully.');
  });
}

function processNewText(text) {
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;

    const urlMatch = line.match(URL_RE);
    if (urlMatch) {
      fs.writeFileSync(URL_FILE, urlMatch[1] + '\n');
      log(`current public URL: ${urlMatch[1]} (written to ${path.basename(URL_FILE)})`);
    }

    if (DEAD_TUNNEL_PATTERNS.some((re) => re.test(line))) {
      restartTunnel(`saw "${line.trim().slice(0, 120)}"`);
    }
  }
}

function poll() {
  fs.stat(LOG_FILE, (statErr, stats) => {
    if (statErr) {
      // Log file doesn't exist yet (tunnel process never started, or
      // pm2 log rotation just ran) -- nothing to read, try again later.
      return;
    }
    if (stats.size < lastPosition) {
      // File got rotated/truncated since we last read it -- restart
      // from the top rather than seeking past the new content.
      lastPosition = 0;
    }
    if (stats.size === lastPosition) return; // nothing new

    const stream = fs.createReadStream(LOG_FILE, { start: lastPosition, end: stats.size - 1, encoding: 'utf8' });
    let chunkText = '';
    stream.on('data', (chunk) => {
      chunkText += chunk;
    });
    stream.on('end', () => {
      lastPosition = stats.size;
      processNewText(chunkText);
    });
    stream.on('error', (err) => log('error reading log file:', err.message));
  });
}

log(`watching ${LOG_FILE} for a dead tunnel session every ${POLL_MS / 1000}s...`);
// Start from the END of whatever's already there -- this watchdog cares
// about NEW failures from here on, not re-processing history from
// before it started (which could otherwise trigger an immediate restart
// based on old, already-resolved log lines).
try {
  lastPosition = fs.statSync(LOG_FILE).size;
} catch {
  lastPosition = 0;
}
setInterval(poll, POLL_MS);
