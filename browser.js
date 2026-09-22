// browser.js
//
// One place that launches Chromium, so every script (check.js, server.js,
// discover.js) behaves the same way. Normally this is just
// `chromium.launch()` -- Playwright downloads and manages its own browser
// binary (see README: `npx playwright install chromium`).
//
// PLAYWRIGHT_EXECUTABLE_PATH is an escape hatch for servers/containers
// that already have a system Chromium and would rather point at that
// than let Playwright manage a second copy (handy in some Docker setups,
// and how this project's own tests ran against the sandbox's preinstalled
// browser during development).
//
// channel: 'chromium' forces Playwright to use the FULL Chromium build
// rather than the separate, smaller "headless shell" browser it uses by
// default for headless launches -- on at least some Windows setups, that
// shell binary (chrome-headless-shell.exe) has been seen opening a real,
// visible (blank) window instead of staying properly hidden, which is
// exactly backwards for something meant to run invisibly every few
// minutes. The full browser's own headless mode doesn't have this
// problem. Only applies when no executablePath override is given --
// channel and executablePath can't be combined.
function launchBrowser(chromium) {
  const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  return chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : { channel: 'chromium' }),
  });
}

module.exports = { launchBrowser };
