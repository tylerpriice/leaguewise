# Contributing to Leaguewise

Thanks for wanting to help. This page says how the repository works, how to run the extension and its tests, and what happens to a pull request.

## How this repository works

**This repository is a publish, not the place the work happens.** Leaguewise is developed in a private working repository, and this one is generated from it at each release. Two things follow from that, and it is better you hear them here than find out later:

- **The history is publish by publish.** You will see the commits that published each release, not the day-to-day commits behind them.
- **A pull request is not merged here.** It is reviewed here, in the open. If it is accepted, the change is applied in the working repository, and it appears in this one at the next publish. You are credited by name in `CHANGELOG.md` and in the release notes. The pull request is then closed with a link to the release that carries it.

What is published is the real source. The extension has no build step: the files in this repository are the files a browser runs, and the store packages are those files zipped. The comments are edited for publication, and the code is copied byte for byte.

## Where to start

- **A question, or not sure it's a bug?** Ask in [Discussions, under Q&A](https://github.com/tylerpriice/leaguewise/discussions/categories/q-a).
- **An idea?** Start it in [Discussions, under Ideas](https://github.com/tylerpriice/leaguewise/discussions/categories/ideas).
- **A bug, or a league format Leaguewise reads wrongly?** [Open an issue](https://github.com/tylerpriice/leaguewise/issues/new/choose). The forms ask for what we need.
- **A security problem?** Report it privately. `SECURITY.md` says how.

Please talk to us before writing a large change. A short discussion first saves you from building something that can't be taken.

## Never post your league's data

The extension's Diagnostic export, and any payload copied from ESPN, hold your league's data: team names, owners, rosters. Don't attach them to an issue, a discussion, or a pull request, and don't commit them. Describe the league's settings in words. If we need more, we'll ask for the smallest piece that answers the question.

## Running it

There is nothing to install. You need a browser and any static file server, because the pages load JavaScript modules and those don't load from `file://`.

```
python -m http.server 8123
```

Then open:

- `http://localhost:8123/dev-preview.html` for the dashboard, running on a sample league with no ESPN account.
- `http://localhost:8123/tests/run-all.html` for every test suite in one pass. A green header is a pass.

To run it as an extension against your own leagues, load the folder as a temporary add-on: `about:debugging` in Firefox, or `chrome://extensions` with Developer mode on in Chrome.

## What a change needs

- **Every suite green**, in Firefox and in Chrome. The same page runs in CI on each pull request.
- **Tests for new math.** Calculations live in modules with no page and no network in them, so they can be tested. Expected values in a test are worked out by hand from the formula, not copied from the code's output.
- **Plain JavaScript modules and one stylesheet.** No framework, no dependency, no bundler, no build step.
- **Colours through the stylesheet's custom properties**, with a light and a dark value each.
- **Comments that say why**, not what.
- **`dashboard.html` and `dev-preview.html` kept in step.** A markup change in one is made in the other.

## What won't be accepted

Leaguewise reads your league in your own browser, with your own ESPN session, and your league's data is never sent anywhere. Changes that would end that are declined, however useful:

- a new permission, or a new host the extension contacts
- a server, an account, or anything that stores league data outside the browser
- telemetry, analytics, or advertising
- anything that writes to ESPN: setting a lineup, making a claim, proposing a trade

[ROADMAP.md](ROADMAP.md) has the direction, and the full list of what Leaguewise will never do.

## Conduct

This project follows the Contributor Covenant. See `CODE_OF_CONDUCT.md`.

## Contact

Questions that don't fit Discussions: support@leaguewise.net
