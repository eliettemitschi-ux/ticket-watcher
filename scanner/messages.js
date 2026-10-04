// Wording for the three alert kinds, kept pure so it can be tested.

const { formatLondon } = require('./time');

function describeOpens(opens) {
  if (!opens) return 'No booking date announced yet';
  const at = Date.parse(opens.at);
  if (opens.precision === 'month') return `Booking opens ${opens.label}`;
  if (opens.precision === 'exact') return `General sale ${formatLondon(at)}`;
  return `General sale ${formatLondon(at, { withTime: false })}`;
}

function reasonsLine(record) {
  return record.reasons && record.reasons.length ? `Flagged: ${record.reasons.join('; ')}` : record.selection === 'on' ? 'You ticked this show' : '';
}

/** @returns {{title:string, message:string}} */
function alertMessage(kind, record) {
  const lines = [];
  let title;
  if (kind === 'announced') {
    title = `${record.venue}: new show announced - ${record.title}`;
    lines.push(describeOpens(record.opens));
  } else if (kind === 'headsUp') {
    title = `Opens soon: ${record.title}`;
    lines.push(`${record.venue} · ${describeOpens(record.opens)}`);
    if (record.opens && record.opens.membersAt && Date.parse(record.opens.membersAt) < Date.parse(record.opens.at)) {
      lines.push(`Members' presale was ${formatLondon(Date.parse(record.opens.membersAt), { withTime: false })}`);
    }
  } else {
    title = `${record.venue} on sale now: ${record.title}`;
    const n = (record.days || []).length;
    if (n) lines.push(`${n} date${n === 1 ? '' : 's'} listed`);
    if (record.generalSaleText && record.venue === 'National Theatre') lines.push(`Public tickets ${record.generalSaleText}`);
  }
  const why = reasonsLine(record);
  if (why) lines.push(why);
  return { title, message: lines.join('\n') };
}

module.exports = { alertMessage, describeOpens };
