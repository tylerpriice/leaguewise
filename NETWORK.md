# What Leaguewise contacts

Leaguewise reads your ESPN league in your own browser, with your own ESPN session. Your league's data is never sent anywhere: not to us, not to anyone else. This page lists every host the extension contacts, what goes to each one, and how to check all of it yourself in about a minute.

The same list as data is in [`network-surface.json`](network-surface.json). Before each release a script reads every shipped file and fails if the code names a host that list does not, or the list names one the code does not, so this page cannot quietly fall behind the code.

Links to code on this page point at the `v1.7.0` tag, so they keep showing the code this page describes.

## The short version

- Leaguewise contacts **ESPN's own servers and nothing else**: six hosts, all on `espn.com` or `espncdn.com`.
- Your ESPN cookies travel **to ESPN and nowhere else**. The browser attaches them to requests for ESPN's API, exactly as it does when you open ESPN's site. The extension never copies them into a request of its own and never sends them to another host. It does not store your session cookie. "Where your data rests" below says what it keeps of your account id.
- There is **no Leaguewise server**. There is nothing for your league to be sent to.
- Every request the extension makes is a **read**. It never sets a lineup, makes a claim, or proposes a trade. The one thing it can do on ESPN is press ESPN's own Draft button in the draft room, for a player you chose, when you ask it to.

## Every host, and what is sent

All requests are HTTPS `GET`s.

| Host | What it is for | What is sent | When |
|---|---|---|---|
| `lm-api-reads.fantasy.espn.com` | ESPN's fantasy API: the league, its past seasons, rosters, the player pool, player lines, the draft, transactions, and the pro-team schedule | Your ESPN cookies, attached by the browser. The league id and season, in the address. On player-pool requests, an `X-Fantasy-Filter` header saying which players and stats to return | When a league opens, and as you open the tab that needs each part |
| `fan.api.espn.com` | ESPN's account lookup: the list of leagues on your ESPN account, so you can pick one | Your ESPN cookies, attached by the browser. Your `SWID`, ESPN's id for your account, in the address | When the extension opens |
| `site.api.espn.com` | ESPN's public scoreboard, for betting lines beside a matchup | Your ESPN cookies, attached by the browser. The sport, in the address | **Only if you turn the betting-lines option on.** It is off by default |
| `a.espncdn.com` | Player headshots and pro-team logos | A player id or a club abbreviation, in the address. No cookies: it is a different domain | As rows that show them scroll into view |
| `g.espncdn.com` | Fantasy team logos | The logo's own address, as your league's data gives it. No cookies | Where a team's logo is drawn |
| `mystique-api.fantasy.espn.com` | Fantasy team logos that a manager uploaded to ESPN | The logo's own address, as your league's data gives it | Where a team's logo is drawn |

Two things about that table:

- **The filter header is not your data.** `X-Fantasy-Filter` is a request for a slice of ESPN's player pool: which players, which scoring periods, how many rows.
- **A team logo's address comes from your league.** A manager can set any picture as a team logo, so its address is the one thing in this list the extension does not write itself. Before any logo is loaded, [`images.js`](https://github.com/tylerpriice/leaguewise/blob/v1.7.0/src/views/images.js) checks the address is on `espn.com` or `espncdn.com` (`isAllowedLogoUrl`). An address anywhere else is not loaded at all, and the team's initials are drawn in its place.

## The one place a request is made

Every API request goes through one function, `fetchEspnJsonOverWire` in [`src/data/api.js`](https://github.com/tylerpriice/leaguewise/blob/v1.7.0/src/data/api.js). It is the only call to `fetch` for a remote address in the extension. Search the repository for `fetch(` and you will find it, plus one read of the extension's own `manifest.json` for the version number.

Images are plain `<img>` tags, built in [`src/views/images.js`](https://github.com/tylerpriice/leaguewise/blob/v1.7.0/src/views/images.js).

## The one ESPN page the extension runs on

Leaguewise is its own page. It does not add anything to ESPN's site, with one exception: **ESPN's draft room**, at addresses matching `fantasy.espn.com/*/draft*`.

There, while a draft is on, a script reads the draft's own messages in your tab, so the Draft tab can follow the picks live. It opens no connection of its own: your draft-room tab is the only client, and what it reads stays in your browser. If you ask it to, it presses ESPN's own Draft button for a player you chose. It runs on no other ESPN page.

## What is never contacted

| Not contacted | How you can tell |
|---|---|
| A Leaguewise server | There isn't one. `leaguewise.net` appears in the code once, as the add-on's id in `manifest.json`, which is a name and not an address anything is sent to |
| Analytics, telemetry, error reporting, ads | No such host is in the list above, and the release check fails if the code ever names a host this page does not |
| Baseball Savant | Its park factors are a table of numbers inside the code ([`matchup-difficulty.js`](https://github.com/tylerpriice/leaguewise/blob/v1.7.0/src/engines/matchup-difficulty.js), `MLB_PARK_FACTORS`), credited on the page. Nothing is fetched |
| Any site that is not ESPN's | The extension's only host permission is `*.espn.com`. See [PERMISSIONS.md](PERMISSIONS.md) |
| Code from the network | Every script the extension runs is in the package. Extension pages run under the browser's default policy for extensions, which refuses scripts from a remote address and refuses `eval` |

## Where your data rests

Leaguewise has no server, so everything it keeps is in the browser's own extension storage, on your machine. Removing the extension removes all of it.

**Until the browser closes** (`storage.session`):

| Key | Holds |
|---|---|
| `apiData` | The league you have open, as ESPN returned it, so reopening the tab does not fetch it again |
| `leagueHistoryYears`, `leagueHistoryKey` | Which seasons the league has |
| `discoveredLeagues:<SWID>`, `leaguesToday:<SWID>` | The leagues on your account |
| `proTeamSchedules:<sport>:<year>` | The pro-team schedule |
| `scoreboard:<sport>:<year>:<hour>` | The scoreboard, if betting lines are on |
| `lastLeagueFetchKey`, `lastLeagueFetchAt` | When the open league was last fetched |

**Until you remove them** (`storage.local`):

| Key | Holds |
|---|---|
| `sport`, `leagueId`, `year` | The league you last opened, so it opens again |
| `nicknames:<sport>:<league>` | Short team names you typed |
| `draftPlan:`, `draftNotes:`, `draftLog:`, `draftTrayWidth:`, `rankingsFile:` (each `<sport>:<league>`) | Your draft plan, your notes on players, the pick log, a panel width, and a rankings file you loaded |
| `roomState` | The draft room's last known state, while a draft is on |
| `preseason:<...>` | The projections ESPN showed before the season, kept because ESPN overwrites them |

A few keys beginning `scout` are defined in `api.js` for a page that is not part of the published package. Nothing in the package writes them.

**Preferences**, in the page's own storage: `efv-theme`, `efv-style`, `efv-odds`, `efv-diagnostic`, and the open tab.

Player lines, the player pool, and past seasons are held in memory only, for as long as the page is open.

The extension asks the browser for two ESPN cookies, `SWID` and `espn_s2`, to know you are signed in to ESPN. It never stores `espn_s2`, your session cookie, and reads it only to see that it exists. `SWID` is ESPN's id for your account: its value is kept in memory while the page is open, to tell which team is yours, and it is part of the two storage keys marked `<SWID>` above, which last until the browser closes.

## Check it yourself, in about a minute

You do not have to take this page's word for any of it.

1. Open Leaguewise in a full tab.
2. Press **F12** and choose the **Network** tab in the tools that appear.
3. Reload the page, load a league, and click through the tabs.
4. Read the **Domain** column. Every remote row is one of the six hosts in the table above. Rows for the extension's own files are the package itself.

The draft-room script makes no request of its own, so it adds no row anywhere. The requests in a draft-room tab are ESPN's own page's.

Leaguewise can show you the same thing itself: turn on **Diagnostic panel** in its settings, and the panel lists what the page has asked for since it opened.

If you ever see a request to a host that is not on this page, that is a bug or worse, and we want to know. [SECURITY.md](SECURITY.md) says how to report it privately.
