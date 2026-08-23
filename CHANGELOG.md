# Changelog

## 1.5.0 (2026-08-22)

Added
- Boxscore, a second look, black and gold in both sports. It is now the default; the previous look is Modern. Style and theme are under Display in the settings.
- Pennants and banners on the League History wall take their colour from the team's logo.
- Player comparison. Open a player, press Compare, and pick another player of the same role. Both lines draw on one chart, with a category strip and a ledger of who leads where.
- The player chart colours each matchup point: gold ring for the season's best, green above the player's own typical week, red below.
- Click a matchup point to open that matchup day by day. The axis shows the dates; hovering a day shows its score and the stat line.
- Matchup Score explainer. The info mark on the chart opens a worked example from the player's own week: the week's line, one percentile bar per category, and the average that is the score.
- Roto leagues get the Current timeframe, and the race draws the matchup being played day by day.
- The careers pane in League History shows a spinner while loading and a chip per season. Two seasons load at once; the others load when their chip is clicked.

Changed
- Records count finished matchups only. The matchup being played contributes to live scores and nothing else.
- Live data is re-read five minutes after the last read rather than on every render, and large fetches are paced. Fewer requests reach ESPN.
- The crown marks a champion only. During the season the leader is first in the standings, with no crown.
- The diagnostic panel's tally separates API calls from image loads.

Fixed
- Live matchup scores could sit a day stale. The scoreboard reads ESPN's live tally, and games started updates with it.
- Reopening the dashboard did not refresh the league. It revalidates on open without changing the tab you are on.
- Changing the timeframe while comparing two players did not redraw the comparison.
- The Current timeframe on the first day of a matchup showed nothing.
- Rate categories in the race chart were summed across days instead of recomputed.
- The category heatmap's tint had no dark mode.

## 1.4.1 (2026-08-09)
- Fixed: the utility rail down the right edge sat a scrollbar-width short of the edge, with a strip of empty background beside it.
- The diagnostic panel is a drawer at the foot of the window now, over the page rather than under it, and scrolls inside itself. With it switched on the page no longer scrolls, which is what left that strip beside the rail.

## 1.4.0 (2026-08-08)
- League History: a fourth tab covering every season your league has played.
- Each season hangs down the side as a pennant for baseball or a rafter banner for hockey, naming its champion and carrying that team's logo when ESPN has one.
- All-time standings rank every franchise that has ever played, by titles, record, and win percentage, and name the seasons a record covers when some of them were roto.
- Rivalries: pick an opponent and read the whole history against them. Who leads, a bar for each season, the current streak, the last meeting, the longest run and the matchups it spanned, playoff meetings, and titles.
- Player careers total every player across every season, sortable by any column and split by role.
- A career's franchises come from the draft and the transaction log rather than from whoever holds the player today, so a stint that ended in a drop still counts.
- Categories by season shows what each season scored, and which format it was played in.
- The tab bar is rebuilt. The timeframe control composes a span of the season with a recent window inside it, and Legend, Export and Recap moved to an icon rail at the edge of the page.
- Tied standings read T2 rather than #2, everywhere a rank appears.
- The matchup scorecard sits beside the logo instead of taking a line of its own.
- A diagnostic panel setting, off by default. Turned on, it also counts what the page has asked for since it opened, with API calls and image loads listed apart.
- Fixed: Player Metrics could push the page sideways at narrow window widths.
- Fixed: opening the rank explanation shrank the chart underneath it instead of pushing it down.

## 1.3.0 (2026-08-05)
- Schedule: a calendar of your pitchers' projected starts for the matchup, one card per start, with the opponent and the day. Flip between it and your category lines from the same header.
- Every start carries a difficulty read, and the evidence sits one click away: the opposing lineup's strength category by category, and the ballpark, with its run index and where it sits among the 30.
- Park factors come from Baseball Savant's published run index, so a start at Coors and a start in a pitcher's park stop reading the same.
- Betting lines are opt-in and off by default. Left off, nothing is fetched and the cards read exactly as they did.
- My Team's roster is laid out from the league's roster size rather than from the team on screen, so switching teams no longer resizes the text. Rows fill the space they are given, and the two role groups keep their columns aligned.
- An unranked player says why. A player below the minimum games shows the reason instead of a rank, and a closer is ranked against pitchers wherever you open him from.
- Fixed: the roster's category columns and the leaderboard's answered the same question two different ways, so one league's categories rendered at two widths on two tabs.
- Fixed: switching to a league with more categories and back left the roster scrolling sideways.

## 1.2.1 (2026-07-28)
- Projected starts: a pitcher column on My Team counting the starts each of your pitchers is projected to make in the current matchup, with the day and opponent of every one of them behind the number. Projections, not promises, and they move as lineups are posted.
- An availability icon next to any player who is day to day, on the IL, out or suspended. It shows on the leaderboard, on your roster and in the player drill-down, with the exact status on hover.
- Logged out, the app now says so and offers the login instead of printing a status code at you. Log in with the page still open and it heals itself where you are standing, on whichever tab you are on.
- Fixed: My Team changed size when you clicked a timeframe, opened the settings bar, or left for another league and came back. The roster now decides its layout once on entry and holds it.
- Fixed: on the Current timeframe, My Team and Season Trends showed full-season numbers instead of the matchup being played.
- Fixed: a category with no innings or at-bats yet reports an infinite rate during a live matchup, which took the whole page down. It now reads as an infinity sign.
- Fixed: the page could scroll sideways because of a tooltip nobody could see, and the scrollbar that appeared then brought a vertical one with it.
- Fixed: My Team rows carried more space than they needed, and category headers did not sit over their values. Columns now measure the roster on screen and fill the row they are given, with the two role groups staying aligned to each other.

## 1.2.0 (2026-07-27)
- My Team: a third tab, showing your own roster with each player's rank and category line, and a switcher to scout any other team in the league. Works during a live matchup and after a season ends.
- Player photos on the roster and the drill-down, with initials shown until a photo loads.
- Points leagues get a real player rank, everywhere a rank appears: the leaderboard, the drill-down cards, and the Prev and Next walk through the rankings. A points-per-matchup trend leads the drill-down chart.
- The timeframe selector is two controls that combine: which part of the season, and how recent a stretch inside it. You can now ask for the last four matchups of the regular season, which was not expressible before.
- Fixed: stat days were assigned to matchups by assuming every matchup is seven days long. Real leagues have longer opening weeks and folded break weeks, so production was landing in the wrong matchup all season. Matchup boundaries now come from your league's own schedule.
- Fixed: the This Matchup timeframe showed the matchup that just ended rather than the one being played.
- Fixed: a playoff bye counted as a loss, so a team that won every playoff game could show a defeat.
- Fixed: recaps for points leagues ranked teams by points scored instead of by matchups won.

## 1.1.2 (2026-07-24)
- Hockey leagues are supported alongside baseball, in every format: weekly categories, weekly points, and season-long roto.
- The Roto Race: a season-long standings chart for roto leagues rebuilt from your league's own daily lineups, with timeframe filters that re-score the standings over any window of weeks.
- The This Matchup view shows every matchup as a card with a live scoring race. Each card pops out to a full chart with exact daily values, and playoff cards say what each series is for.
- Category rankings show one category at a time with arrows to cycle through them, and a season race chart under every ranking.
- Standings sections flip between bars and pies. Nothing on the Team Metrics tab scrolls and nothing hides behind a dropdown.
- Pop-out charts for Season Trends and the heatmap, sortable heatmap columns, an icon legend, faster trend arrows.
- Store installs on Firefox now ask for espn.com access on first run, which they need before the extension can read your ESPN login.
- Fairness fixes in the player rankings: every scored category counts for every player, and ties split points the way roto standings always have.

Versions 1.1.0 and 1.1.1 were packaging casualties and never worked from the stores. 1.1.2 is the release they were meant to be, and the packaging script now refuses to build an archive with an unresolvable import or a corrupt image.

## 1.0.1 (2026-07-23)
- Fixed a corrupt icon that blocked every Chrome install.

## 1.0.0 (2026-07-18)
- First release: standings, season trend lines, category heatmap, live weekly scoreboard, the ranked player leaderboard, player drill-downs, CSV export, and shareable recap images. ESPN Fantasy Baseball category leagues.
