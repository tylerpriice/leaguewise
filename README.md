<p align="center"><img src="banner.svg" width="460" alt="Leaguewise"></p>

<p align="center">League analytics for ESPN Fantasy Baseball and Hockey, as a browser extension. Firefox today, with Chrome and Edge on the way.</p>

Point it at your league and it turns the season into something you can actually read: standings that show how you got here, trend lines, category heatmaps, a full player leaderboard with its own ranking engine, and shareable weekly recaps for the group chat.

## Built with AI, reviewed by humans

AI does a lot of the typing here. Humans review and test every change before it lands. The unit tests assert hand-computed values, and all ESPN stat ids are checked against real stat lines before use.

If AI involvement bothers you, fair enough. The entire source is here to read, and it's small.

## Your data stays in your browser

- No backend. The extension runs entirely in your browser. This project operates no servers.
- It talks to exactly one place: ESPN's fantasy API, authenticated by the ESPN login already in your browser. The manifest's host permission is espn.com and nothing else.
- No analytics, telemetry, tracking, or crash reporting. There is nowhere to phone home to.
- Three permissions, each with one job: `cookies` (your ESPN session, so the API calls work), `storage` (your settings), `clipboardWrite` (the export button).
- Zero dependencies and no build step. The code in this repository is byte for byte the code that runs, and the supply chain is just this repository.
- League data captured during development is gitignored and never committed.

## What it does

- **Team Metrics**: standings with playoff-tier shading and W-L-T records, season trend lines, category rankings, a category-dominance heatmap, live weekly scoreboards, and one shared timeframe control (full season, regular season, last N matchups, playoffs).
- **Player Metrics**: a full-league player leaderboard driven by a custom Roto-style rank engine (percentile per category against qualified peers, playing-time adjustment, opportunity gating for saves and quality starts, role-aware relief pitcher handling, two-way player support), plus search, position, and availability filters, and a per-player drill-down with weekly trend charts.
- **Export**: CSV or clipboard export of standings, category totals, or the player leaderboard exactly as configured on screen.
- **Recap**: a shareable image and text summary of a matchup week, sized for posting into a league group chat.

## Install (for development and testing)

Chrome and Edge builds are in progress. These steps cover Firefox for now.

1. Clone this repository.
2. In Firefox, go to `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and select `manifest.json` from the clone.
3. Click the extension icon, enter your league's sport, ID, and year, and hit **Fetch Data**.

Temporary add-ons are removed when Firefox restarts. There's no packaged build step. The extension runs straight from these source files.

## Running the dev preview (no ESPN account needed)

`dev-preview.html` runs the full dashboard on a plain static file server, with `tests/browser-stub.js` faking the WebExtension APIs and loading a captured league payload instead of making real ESPN calls.

1. Capture a payload: load the real extension against a real league, then use the Diagnostic Data panel at the bottom of the page to download a JSON dump. Put it in a `JSON_debug/` folder at the repository root. That folder is gitignored because it holds real league data. Don't commit it.
2. Serve the repository root with any static file server:
   ```
   python -m http.server 8123
   ```
   ES module imports won't load over `file://`, so it has to be served over `http://`.
3. Open `http://localhost:8123/dev-preview.html`. Switch payloads with `?payload=<filename>`.

## Running the tests

The pure functions (the rank engine, and the CSV and recap builders) have in-browser unit tests with no test runner. Open them through the same static server:

- `http://localhost:8123/tests/rank-engine.test.html`
- `http://localhost:8123/tests/features.test.html`

A green header means everything held.

## Stack

Vanilla ES modules, one CSS file, no framework, no build step, no dependencies.

## Contributions

Outside contributions aren't being accepted right now. Issues are welcome.

## License

See `LICENSE` (Mozilla Public License 2.0).
