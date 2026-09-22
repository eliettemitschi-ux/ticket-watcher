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

async function sendNtfy({ title, message, url }) {
  if (!ntfyConfigured()) return { skipped: true };
  const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
  const topic = process.env.NTFY_TOPIC;

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
  const title = `Tickets available: ${what}`;
  const message = `${event.venue ? event.venue + ' — ' : ''}${what} just changed from sold out to bookable.`;

  const results = {};
  try {
    results.ntfy = await sendNtfy({ title, message, url: event.url });
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

module.exports = { notifyAvailable, sendNtfy, sendEmail, ntfyConfigured, emailConfigured };
