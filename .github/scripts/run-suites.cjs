// Opens tests/run-all.html in one browser, waits for every suite to report, and fails the run on
// anything that is not green. Run by .github/workflows/tests.yml on GitHub's runner; it needs the
// playwright package and a server already serving the repository.
//
//   BROWSER=chromium|firefox SUITES_URL=http://127.0.0.1:8123/tests/run-all.html node run-suites.cjs
//
// run-all.html does the work: it loads each suite in turn and, when it is finished, sets
// window.__DONE and leaves one object in window.__RUN_ALL - the counts, and a row per suite. This
// script only waits for that and reads it, so a browser on a runner and a person opening the page
// see the same result.
//
// WHAT FAILS THE RUN, each one said by name:
//   - a suite that is not green, which includes one that loaded and never wrote a summary: the page
//     reports that as its own row, since a script that does not parse prints nothing anywhere
//   - the page itself never finishing inside the time allowed
//   - no suite green at all, so an empty page cannot pass
//   - a suite ABSENT from this tree that is not on the list of suites this repository leaves out.
//     An absent suite is listed, never counted as passed; one that is absent without being on the
//     list is a suite somebody lost.
//
// CommonJS on purpose: the playwright package is installed outside the repository, and NODE_PATH,
// which is how it is found, is read by require and not by import.
const fs = require('fs');

const browserName = process.env.BROWSER || 'chromium';
const url = process.env.SUITES_URL || 'http://127.0.0.1:8123/tests/run-all.html';
const allowedAbsent = (process.env.ALLOWED_ABSENT || '').split(',').map(s => s.trim()).filter(Boolean);
// The page allows each suite twenty seconds to load and fifteen to report, and tries a red one
// twice. A healthy run is well under a minute; this ceiling is for a run that is not healthy.
const DONE_TIMEOUT_MS = Number(process.env.DONE_TIMEOUT_MS || 15 * 60 * 1000);
const summaryPath = process.env.GITHUB_STEP_SUMMARY || '';

const lines = [];
const say = (text = '') => { lines.push(text); console.log(text); };
// A table cell: a pipe would end the cell and a newline the row.
const cell = (text) => String(text === undefined || text === null ? '' : text).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const finish = (code) => {
    if (summaryPath) fs.appendFileSync(summaryPath, lines.join('\n') + '\n');
    process.exit(code);
};

(async () => {
    const playwright = require('playwright');
    const launcher = playwright[browserName];
    say(`### The suites in ${browserName}`);
    say();
    if (!launcher || typeof launcher.launch !== 'function') {
        say(`FAILED: no such browser to launch: ${browserName}`);
        return finish(1);
    }

    const browser = await launcher.launch();
    const failures = [];
    let result = null;
    let version = '';
    try {
        version = browser.version();
        const page = await browser.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
        await page.goto(url, { waitUntil: 'load' });
        try {
            await page.waitForFunction(() => window.__DONE === true, null, { timeout: DONE_TIMEOUT_MS });
        } catch (e) {
            failures.push(`the page never finished inside ${Math.round(DONE_TIMEOUT_MS / 1000)} seconds`);
        }
        result = await page.evaluate(() => (window.__RUN_ALL ? JSON.parse(JSON.stringify(window.__RUN_ALL)) : null));
        if (pageErrors.length) failures.push(`the page itself threw: ${pageErrors.join('; ')}`);
    } finally {
        await browser.close();
    }

    if (!result || !Array.isArray(result.rows)) {
        if (!failures.length) failures.push('the page finished and left no result to read');
        say(`${browserName} ${version}`);
        say();
        failures.forEach(f => say(`- FAILED: ${f}`));
        return finish(1);
    }

    const rows = result.rows;
    const absent = rows.filter(r => r.cls === 'absent').map(r => r.name);
    const notGreen = rows.filter(r => r.cls !== 'pass' && r.cls !== 'absent');
    const unexpected = absent.filter(name => !allowedAbsent.includes(name));
    if (result.red > 0 || notGreen.length) failures.push(`${Math.max(result.red, notGreen.length)} suite(s) not green: ${notGreen.map(r => r.name).join(', ')}`);
    if (!(result.green > 0)) failures.push('no suite was green');
    if (unexpected.length) failures.push(`absent and not on the list of suites left out: ${unexpected.join(', ')}`);

    say(`${browserName} ${version}: ${result.green} green, ${result.red} not green, ${result.absent} absent, ${result.assertions} assertions.`);
    say();
    if (absent.length) {
        say(`Absent from this tree, and so not run: ${absent.join(', ')}.`);
        say();
    }
    failures.forEach(f => say(`- FAILED: ${f}`));
    if (failures.length) say();
    say('| suite | result |');
    say('|---|---|');
    rows.forEach(r => say(`| ${cell(r.name)} | ${cell(r.cls === 'absent' ? 'absent' : r.text)} |`));
    say();
    return finish(failures.length ? 1 : 0);
})().catch((e) => {
    say(`FAILED: ${e && e.stack ? e.stack : e}`);
    finish(1);
});
