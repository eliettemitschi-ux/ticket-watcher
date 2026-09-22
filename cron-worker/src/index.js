// cron-worker/src/index.js
//
// Every 5 minutes (a real, precise Cloudflare Cron Trigger -- see
// wrangler.toml for why this exists), fires the "Check events"
// GitHub Actions workflow via workflow_dispatch. API-triggered runs
// start immediately, unlike GitHub's own `schedule:` trigger, which is
// documented as best-effort and was observed running 3-4x slower than
// requested in practice.
//
// GITHUB_TOKEN is a Worker secret (set via `wrangler secret put
// GITHUB_TOKEN`), not hardcoded here -- it's the same token the `gh` CLI
// already uses locally (scopes: repo, workflow), reused rather than
// minting a brand new one, since it already has exactly the access
// this needs and already lives on this same machine.

const OWNER = 'eliettemitschi-ux';
const REPO = 'ticket-watcher';
const WORKFLOW_FILE = 'check.yml';
const REF = 'master';

async function triggerCheck(env) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ticket-watcher-cron-worker',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: REF }),
  });

  if (res.status !== 204) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API returned ${res.status}: ${body.slice(0, 300)}`);
  }
  return { ok: true };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      triggerCheck(env)
        .then(() => console.log('Triggered check.yml successfully.'))
        .catch((err) => console.error('Failed to trigger check.yml:', err.message))
    );
  },

  // A plain GET lets you manually trigger a run (or just sanity-check
  // the Worker is deployed and reachable) by visiting the Worker's own
  // URL in a browser -- not required for normal operation, just handy.
  async fetch(request, env) {
    try {
      await triggerCheck(env);
      return new Response('Triggered check.yml successfully.\n');
    } catch (err) {
      return new Response(`Failed: ${err.message}\n`, { status: 500 });
    }
  },
};
