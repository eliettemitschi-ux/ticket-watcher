// notify.js
//
// Fires alerts on whichever channels are configured in .env. Both
// channels are optional and independent -- set up ntfy, email, or both
// ("belt and braces"). If neither is configured, checks still run and
// the dashboard still updates, you just won't get pinged.

const fetch = require('node-fetch');
const nodemailer = require('nodemailer');

function ntfyConfigured() {
  return Boolean(process.env.NTFY_TOPIC);
}

function emailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.NOTIFY_EMAIL_TO);
}

// Derives a per-event ntfy topic from the shared base topic, so anyone
// can subscribe to just one show instead of everything -- no accounts,
// just a second free topic name. Slugified from the event's own name for
// readability (e.g. "BARBICAN-1999-golden-boy-a1b2"), with a short slice
// of the event's id appended so two similarly-named shows (or the same
// show re-added later) can never collide onto the same topic. Computed
// once at addEvent() time and stored on the event -- stable forever
// after, so a link someone's already subscribed to keeps working even if
// this slugify logic changes later.
function topicForEvent(name, id) {
  const base = process.env.NTFY_TOPIC;
  if (!base) return null;
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base}-${slug}-${id.slice(0, 4)}`;
}

async function postNtfy(topic, { title, message, url }) {
  const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
  const res = await fetch(`${server}/${topic}`, {
    method: 'POST',
    headers: {
      Title: title,
      Priority: 'urgent',
      Tags: 'ticket',
      ...(url ? { Click: url } : {}),
    },
    body: message,
  });
  if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
  return { sent: true };
}

async function sendNtfy({ title, message, url, ntfyTopic }) {
  if (!ntfyConfigured()) return { skipped: true };
  const baseResult = await postNtfy(process.env.NTFY_TOPIC, { title, message, url });
  // The per-event topic is best-effort: a subscriber-only feature, not
  // the primary channel -- its failure shouldn't make the whole
  // notification look like it failed when the main topic went out fine.
  if (ntfyTopic) {
    try {
      await postNtfy(ntfyTopic, { title, message, url });
    } catch {
      /* logged by the caller via the returned result if it wants to */
    }
  }
  return baseResult;
}

let cachedTransporter = null;
function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return cachedTransporter;
}

async function sendEmail({ subject, text, url }) {
  if (!emailConfigured()) return { skipped: true };
  const transporter = getTransporter();
  await transporter.sendMail({
    from: process.env.NOTIFY_EMAIL_FROM || process.env.SMTP_USER,
    to: process.env.NOTIFY_EMAIL_TO,
    subject,
    text: url ? `${text}\n\n${url}` : text,
  });
  return { sent: true };
}

/**
 * Notify on every configured channel that an event -- or one specific
 * date/time within it -- just became bookable. Errors on one channel
 * don't stop the other from being tried.
 *
 * @param {object} event
 * @param {string} [performanceLabel]  which date/time this is about, for
 *   events with more than one (e.g. "21 November 2026, 8.30pm"). Omitted
 *   for events with only ever one performance, where it would just repeat
 *   the event name.
 */
async function notifyAvailable(event, performanceLabel) {
  const what = performanceLabel ? `${event.name} (${performanceLabel})` : event.name;
  // Optional -- set NOTIFY_SOURCE_TAG when running more than one deployment
  // against the same notification channel at once (e.g. during the
  // overlap window between the local pm2 setup and the GitHub Actions
  // one), so a push makes it obvious which one actually sent it instead
  // of leaving you guessing whether it's a duplicate.
  const sourceTag = process.env.NOTIFY_SOURCE_TAG ? `[${process.env.NOTIFY_SOURCE_TAG}] ` : '';
  const title = `${sourceTag}Tickets available: ${what}`;
  const message = `${event.venue ? event.venue + ' — ' : ''}${what} just changed from sold out to bookable.`;

  const results = {};
  try {
    results.ntfy = await sendNtfy({ title, message, url: event.url, ntfyTopic: event.ntfyTopic });
  } catch (err) {
    results.ntfy = { error: err.message };
  }
  try {
    results.email = await sendEmail({ subject: title, text: message, url: event.url });
  } catch (err) {
    results.email = { error: err.message };
  }
  return results;
}

module.exports = { notifyAvailable, sendNtfy, sendEmail, ntfyConfigured, emailConfigured, topicForEvent };
