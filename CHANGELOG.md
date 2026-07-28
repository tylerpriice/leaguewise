# Changelog

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
