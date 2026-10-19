# What Leaguewise asks for, and why

When you install Leaguewise, your browser tells you what it will be allowed to do. This page takes each of those lines, says which code needs it, and says what it does not allow.

Leaguewise asks for **three permissions and access to one site**:

```json
"permissions": ["cookies", "storage", "clipboardWrite"],
"host_permissions": ["*://*.espn.com/*"]
```

That is the whole list, from [`manifest.json`](https://github.com/tylerpriice/leaguewise/blob/v1.7.0/manifest.json). There are no optional permissions and nothing is requested later.

## What the browser shows you

Browsers describe permissions in their own words, and the words sound broader than what an extension does with them. These are the lines, as each browser words them.

| The browser says | It comes from | What Leaguewise does with it |
|---|---|---|
| **Firefox:** "Access your data for sites in the espn.com domain" <br> **Chrome:** "Read and change your data on all espn.com sites" | Access to `*.espn.com` | Reads your league from ESPN's fantasy API, with your own ESPN session. See below |
| **Firefox:** "Input data to the clipboard" <br> **Chrome:** "Modify data you copy and paste" | `clipboardWrite` | Copies a table or a recap when you press a Copy button |

`cookies` and `storage` have no line of their own in either browser's install prompt.

Firefox treats site access as something you grant: after installing, it may ask you to allow Leaguewise on `espn.com`, and Leaguewise shows a button for that if it has not been granted.

## Access to espn.com

**Why it is needed.** Your league lives behind your ESPN login. To read it, the extension asks ESPN's fantasy API for it, and the browser attaches your ESPN cookies to that request, the same way it does when you open ESPN's site. A browser only does that for an extension you have given access to the site.

**What it is used for.** Requests to ESPN's API, and one script on one ESPN page. [NETWORK.md](NETWORK.md) lists every request.

**What "read and change" does not mean here:**

- Leaguewise is its own page. It does **not** run on ESPN's site as you browse it. It does not read your ESPN pages, change them, or add anything to them.
- The one exception is **ESPN's draft room** (`fantasy.espn.com/*/draft*`), where a script follows the draft's picks while a draft is on, and can press ESPN's own Draft button for a player you chose when you ask it to. It runs on no other ESPN page. The match pattern is in the manifest's `content_scripts`.
- It never changes anything else on ESPN: no lineup, no claim, no trade, no league setting.
- The access is to `espn.com` only. Leaguewise cannot read or contact any other site.

## cookies

**Why it is needed.** To know whether you are signed in to ESPN before asking for a league, and to tell which team in the league is yours.

**What the code does.** One function, `readEspnCookie` in [`src/data/api.js`](https://github.com/tylerpriice/leaguewise/blob/v1.7.0/src/data/api.js), asks the browser for two cookies by name: `SWID` and `espn_s2`, on `espn.com`.

**What it does not do:**

- It does not read cookies for any other site. It could not: the permission only reaches sites the extension has access to, and that is `espn.com` alone.
- It does not send a cookie anywhere itself. When a request goes to ESPN, the browser attaches your cookies, as it would for ESPN's own site. They go to ESPN and nowhere else.
- It does not store `espn_s2`, your session cookie. It only checks that it exists.
- It does not set, change, or delete any cookie.

**Why cookies at all, and not a login?** Because the alternative is asking you for your ESPN password, or asking you to paste your session cookie into a form. With this permission your session stays where it already is: in your browser, going to ESPN and nowhere else. Leaguewise never sees your password.

## storage

**Why it is needed.** To remember the league you opened, your settings, and things you typed: team nicknames, a draft plan, notes on players.

**What it does not do.** This is the browser's own storage for the extension, on your machine. It is not a cloud, it does not sync to a server of ours, and removing the extension deletes it. [NETWORK.md](NETWORK.md) lists every key.

## clipboardWrite

**Why it is needed.** The Export menu and the weekly recap have Copy buttons. This lets them put a table, a recap's text, or a recap image on your clipboard.

**What it does not do.** Leaguewise does not ask for `clipboardRead`. It can put something on your clipboard when you press Copy. It cannot see what is on your clipboard.

## What is not asked for

No `tabs`, no `history`, no `webRequest`, no `scripting`, no `downloads`, no `notifications`, no `<all_urls>`. Leaguewise cannot see what sites you visit, cannot read other pages, and cannot watch your traffic. It has no background script.

## For a store listing, in three lines

> **ESPN site access:** reads your league from ESPN with your own ESPN login. Your league's data is read in your browser and is never sent anywhere.
> **Cookies:** checks that you are signed in to ESPN. Your cookies go to ESPN and nowhere else.
> **Storage and clipboard:** remembers your league and settings on your machine, and copies a table or recap when you press Copy.
