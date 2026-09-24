// test/notify.test.js -- run with: node test/notify.test.js
//
// Only exercises topicForEvent(), the pure per-event ntfy-topic slug
// function -- the rest of notify.js makes real network calls (ntfy,
// SMTP), which isn't something a unit test should be doing.

const assert = require('assert');
const { topicForEvent } = require('../notify');

let failures = 0;
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) {
    console.log('  expected:', JSON.stringify(expected));
    console.log('  actual:  ', JSON.stringify(actual));
  }
}

const originalTopic = process.env.NTFY_TOPIC;

process.env.NTFY_TOPIC = 'BARBICAN-1999';
check('topicForEvent: slugifies the name and appends a short id suffix', topicForEvent('Golden Boy', 'a1b2c3d4'), 'BARBICAN-1999-golden-boy-a1b2');
check('topicForEvent: strips punctuation', topicForEvent('Electra/Persona', 'a1b2c3d4'), 'BARBICAN-1999-electra-persona-a1b2');
check('topicForEvent: two similarly-named shows never collide (different ids)', topicForEvent('Golden Boy', '11112222') !== topicForEvent('Golden Boy', '33334444'), true);
check('topicForEvent: same name+id is always the same topic (stable)', topicForEvent('Golden Boy', 'a1b2c3d4'), topicForEvent('Golden Boy', 'a1b2c3d4'));

delete process.env.NTFY_TOPIC;
check('topicForEvent: null when ntfy is not configured at all', topicForEvent('Golden Boy', 'a1b2c3d4'), null);

if (originalTopic === undefined) delete process.env.NTFY_TOPIC;
else process.env.NTFY_TOPIC = originalTopic;

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll notify tests passed.');
}
