import { AppState } from './state.js';
import { seasonState, isPreseason, SEASON_STATE } from './season-state.js';
import { advancedCategoryCount, axisUnit, parseTimeframe } from './utils.js';
import { renderLeftColumn, renderRightColumn, renderHeatmapBand } from './graphs.js';
import { renderPlayerLeaderboard, refreshOpenPlayerDetail, rotoWindowsAvailable, rotoWindowMaxWeek, aheadReasons } from './players.js';
import { renderMyTeamTab } from './myteam.js';

// AppState.timeframe is now the ONE shared selection driving Team Metrics graphs, the Player Metrics leaderboard, the player drill-down chart, and its rank chips/breakdown all at once - refresh whichever of those currently have data loaded/open, regardless of which tab is active, so switching tabs never shows stale data for the newly-selected timeframe.
export function handleTimeframeChange() {
    if (AppState.apiData) {
        renderLeftColumn();
        renderRightColumn();
        renderHeatmapBand();
    }
    if (AppState.playerDataLoaded) {
        renderPlayerLeaderboard();
        refreshOpenPlayerDetail();
    }
    // My Team windows with the same pills. Its roster lines, its ranks and its standing all read the current timeframe, so it re-renders here rather than waiting for a tab switch.
    if (AppState.apiData) renderMyTeamTab();
}


// Collapses the sport/league/year/fetch fields behind the small gear button once data has loaded (see processCoreData in data.js) - they're one-time setup, not worth permanent header space. Collapse is animated via the.collapsed class (see.settings-bar in dashboard.css). The first collapse plays a short jump on the gear so it's obvious where the fields went, and a slow interval re-plays it now and then as a gentle reminder - but only while the fields are actually collapsed, never while the user has them open.
const GEAR_REMINDER_HOP_MS = 60000;
let settingsJumpPlayed = false;
let gearReminderTimer = null;

function playGearJump(btn) {
    // Remove + reflow so the animation restarts even if the class is already present.
    btn.classList.remove('jump');
    void btn.offsetWidth;
    btn.classList.add('jump');
    btn.addEventListener('animationend', () => btn.classList.remove('jump'), { once: true });
}

export function collapseSettingsBar() {
    const bar = document.getElementById('settings-bar');
    const btn = document.getElementById('settings-toggle-btn');
    if (!bar || !btn) return;
    bar.classList.add('collapsed');
    document.body.classList.add('settings-closed');
    btn.style.display = '';
    if (!settingsJumpPlayed) {
        settingsJumpPlayed = true;
        playGearJump(btn);
    }
    if (!gearReminderTimer) {
        gearReminderTimer = setInterval(() => {
            const barEl = document.getElementById('settings-bar');
            const btnEl = document.getElementById('settings-toggle-btn');
            if (barEl && btnEl && barEl.classList.contains('collapsed') && btnEl.style.display !== 'none') {
                playGearJump(btnEl);
            }
        }, GEAR_REMINDER_HOP_MS);
    }
}

// Replaced simple label update with dynamic option reconstruction for Playoffs forceDefault is set on a genuine new-season fetch (see processCoreData) - otherwise a selection made on a playoff-less season (which falls back to "reg", see below) would silently carry over and stay stuck on "reg" for the NEXT season fetched too, even one that does have playoffs, hiding its postseason bars for no visible reason.
export function rebuildTimeframeOptions(forceDefault = false) {
    // Roto has no matchup periods, and ESPN only ever serves ONE cumulative season standing - so at league-load time the only honest view is the full season. Windows become possible only once the started-day snapshot harvest lands, which happens asynchronously after this runs; syncRotoTimeframePills below adds the pills THEN, exactly once, so the row never appears/disappears/relabels while the harvest streams in. Start hidden and season-only every fetch; the reset here lets a new league re-decide.
    const toggleEl = document.getElementById('timeframe-toggle');
    if (AppState.isRotoLeague) {
        // ONLY A GENUINE NEW LEAGUE TEARS THE ROW DOWN. This branch used to run on every call, and the pill CLICK handler calls this function - so clicking a roto window set the timeframe, then immediately reset it to 'all', emptied the row and hid it. The window never applied and the pills never came back, because the only thing that rebuilds them is the weekly-progress hook, which has long since stopped firing by the time anyone clicks. So the roto windows have never actually been selectable. Found while adding the Current pill, and confirmed on the untouched Last 4 pill rather than assumed: click it and the row disappears. The forceDefault flag already means "a genuine new league/season fetch" for every other league type, and it is exactly the condition this reset wanted all along.
        if (!forceDefault) {
            // The H2H path highlights the new pill as a side effect of rebuilding the whole row. Returning early skips that, so roto moves the highlight itself - otherwise the window would apply with every pill still looking unselected.
            if (toggleEl) setActiveTimeframeChip(toggleEl, AppState.timeframe);
            return;
        }
        AppState.timeframe = 'all';
        rotoPillsShown = false;
        if (toggleEl) {
            toggleEl.innerHTML = '';
            toggleEl.style.display = 'none';
        }
        return;
    }
    if (toggleEl) toggleEl.style.display = '';

    const maxWk = AppState.maxCompletedWeek;
    const regWks = AppState.regSeasonWeeks;
    const hasPlayoffs = maxWk > regWks;

    // "Full Season"/"Regular Season" are kept short (dropping "+ Playoffs" / "Only") so the pill row has room for the "Matchups" word on every lookback window below, which is worth calling out explicitly. Every window in this app is in MATCHUP units, not real calendar weeks (a playoff matchup can span 2-3 real weeks, since ESPN folds multi-week championship rounds into one matchup) - dropping "Matchups" read as ambiguous, so it stays in the visible label rather than being demoted to a hover-only tooltip. The full "Regular Season + Playoffs" wording for the first option is still available as a native title="" tooltip on hover.
    const options = [];
    // "Full Season" only means something DIFFERENT from "Regular Season" once playoffs have actually started - before that they'd be identical, so skip it entirely.
    if (hasPlayoffs) options.push({ value: 'all', text: 'Full Season', title: 'Regular Season + Playoffs', group: 'span' });
    options.push({ value: 'reg', text: 'Regular Season', group: 'span' });

    // Playoffs sits directly after Regular Season (before the recent-window options), so the pill row reads Full Season -> Regular Season -> Playoffs -> This Matchup -> Last N.
    if (hasPlayoffs) options.push({ value: 'p_all', text: 'Playoffs', group: 'span' });

    // Fixed lookback windows instead of a percentage of the season - simpler to read, and doesn't depend on knowing the real season length. Only offered when there's actually more season before the window than the window itself covers. n=1 is "This Matchup" (not "Last Matchup") - AppState.maxCompletedWeek tracks the latest week with ANY activity, including one currently in progress, so this window shows the live/ongoing matchup while one's underway (see AppState.maxCompletedWeek's own comment in data.js). The group caption carries the unit, so no pill in it repeats the word: Current, Last 4, Last 8, Last 12 under one "Matchup" heading. group marks which segment a pill belongs to: the season SPAN on the left, the recent stretch on the right. A window only APPLIES when the span it sits in is longer than the window itself - "last 8" inside a 3-matchup playoff bracket is not a window, it is the whole thing. The pill still renders, disabled. Removing it changed the strip's width, and since the strip is centred between the tabs and the utilities, every pill in the row jumped sideways on a span click. Which options are live is the only thing that should change.
    const spanLength = (span) => {
        if (span === 'reg') return Math.min(maxWk, regWks);
        if (span === 'p_all') return Math.max(0, maxWk - regWks);
        return maxWk;
    };
    const activeSpan = parseTimeframe(AppState.timeframe).span;
    const spanValues = options.map(o => o.value);
    const span = spanValues.includes(activeSpan) ? activeSpan : (hasPlayoffs ? 'all' : 'reg');
    const unit = axisUnit();
    // O27/S30/S30b: the two forward-looking pills, Next and Rest of season, sit at the FAR right of this SAME segmented group - the group reads as one time axis, past to future (Last 12, Last 8, Last 4, Current, Next, Rest of season), so the iteration order below is itself the display order (renderTimeframeToggle appends each option to its group in the order given). Next/Rest do not compose with the span the way a window pill does (no `window`/`${span}+lastN` value; they drive the separate, shared AppState.ahead field instead, tagged `aheadKey` so the click handler below can tell the two option shapes apart). Greyed with aheadReasons() - the same schedule-existence check the leaderboard's own header/rows read, so a pill can never claim a window the render beneath it would then refuse to draw.
    const ahead = aheadReasons();
    [12, 8, 4, 1].forEach(n => {
        if (maxWk <= n) return;
        const fits = spanLength(span) > n;
        options.push({
            value: `${span}+last${n}`, group: 'recent', window: n, disabled: !fits,
            text: n === 1 ? 'Current' : `Last ${n}`,
            title: !fits
                ? `Only ${spanLength(span)} ${(spanLength(span) === 1 ? unit.long : unit.plural).toLowerCase()} in this span`
                : (n === 1 ? `The ${unit.long.toLowerCase()} being played now` : `The last ${n} completed ${unit.plural.toLowerCase()}`)
        });
        if (n === 1) {
            options.push({
                value: '__ahead_next', group: 'recent', aheadKey: 'next', disabled: !!ahead.next,
                text: 'Next', title: ahead.next || 'Your next matchup, projected'
            });
            options.push({
                value: '__ahead_rest', group: 'recent', aheadKey: 'rest', disabled: !!ahead.rest,
                text: 'Rest of season', title: ahead.rest || 'The rest of the season from today, projected'
            });
        }
    });

    // NO GAMES, NO WINDOW TO CHOOSE. Before the first game every surface reads the same projected line whichever pill is lit, so a live row would offer a choice that changes nothing - a matchup picker on a league with no matchups is the tab describing a season that has not happened. GREYED WITH THE REASON rather than removed, and the reason is the same one the disabled window pills already carry: the chrome keeps ONE SHAPE across the season. Taking the row away would make the preseason tab bar a different shape from the played one, and it is centred between the tabs and the utilities, so every pill in the row would move on the way in and out. The utility cluster beside it is untouched - Legend, Export and Recap all still mean something before a game. R3 (owner override): the row used to grey every pill with a reason here instead of hiding - "No games yet. Every figure on this page is a projection." replaces that with ABSENT, the League History way, so this function no longer greys anything for preseason; the setTimeframeVisible call at the bottom hides the row outright instead.
    const currentVal = forceDefault ? null : AppState.timeframe;
    const fallback = hasPlayoffs ? 'all' : 'reg';
    // A window that the NEW span cannot offer costs the window, not the span. Switching to a four-matchup playoff bracket while holding "last 4" used to throw both away and land back on Full Season, which is not what either click asked for.
    const spanOnly = currentVal ? parseTimeframe(currentVal).span : null;
    const live = (val) => options.some(o => o.value === val && !o.disabled);
    AppState.timeframe = live(currentVal) ? currentVal : (live(spanOnly) ? spanOnly : fallback);

    renderTimeframeToggle(options);
    // R3: re-evaluated on every rebuild (a fresh fetch, a revalidate), not only on a tab click - "the selector returns the moment the season state leaves preseason, on the same call that rebuilds it." setTimeframeVisible's own preseason check wins regardless of what is passed here; the History/Draft tabs are read straight off the DOM since this function has no other way to know which one is active.
    const historyActive = document.getElementById('tab-btn-history')?.classList.contains('active');
    const draftActive = document.getElementById('tab-btn-draft')?.classList.contains('active');
    setTimeframeVisible(!historyActive && !draftActive);
}

// R5/S35: My Team has nothing to show before a draft (rostersFromPayload's own refusal - see myteam.js's "No roster until the draft" state, unchanged by this item). DIMMED says "there is less here right now" without claiming the tab does not exist. R4/S45: the owner OVERRULED R5's "stays clickable" half - "the My Team tab should be unclickable in the preseason, as well as greyed." The tab still exists (dimmed, not removed), it just cannot be entered until a draft has happened: `disabled` on the button (native, so a disabled button fires no click event at all - see main.js's own belt-and-suspenders guard in switchTab) with a title naming why, restored the moment PRE_DRAFT ends since this runs on every rebuild same as the dim class already did.
export function refreshMyTeamTabAvailability() {
    const btn = document.getElementById('tab-btn-myteam');
    if (!btn) return;
    const preDraft = seasonState(AppState.apiData) === SEASON_STATE.PRE_DRAFT;
    btn.classList.toggle('tab-button-dim', preDraft);
    btn.disabled = preDraft;
    btn.title = preDraft ? 'Nothing to show until the draft is held' : '';
}

// A row of always-visible pill buttons (same visual language as.filter-flex/.legend-item elsewhere in this file) - lives directly in.tabs-container (dashboard.html) so it's visible regardless of which tab is active. AppState.timeframe is the real source of truth now (no backing <select> anymore - see state.js). League History answers "how has this league gone", which no timeframe narrows - its seasons are its own axis. So the pills are absent there, and absent is the word: the CONTAINER stays in the row and keeps its flex, so it still absorbs the free space between the tabs and the right edge exactly as it does when full. Hiding the container instead would hand that space back to the tabs and slide them, which is the reflow the ruling forbids. R3: "Regular Season | Matchup" is useless before a game exists, the same reason item 1 once greyed it with a reason instead - the owner has now overridden that ruling to ABSENT, the League History way, rather than present-but-disabled. The preseason check lives HERE, inside the one function every caller (main.js's per-tab switchTab call, this file's own rebuildTimeframeOptions) already goes through, rather than in each caller - so League History's own per-tab toggle (main.js: setTimeframeVisible(!isHistory && !isDraft) on every tab switch) cannot flip the row back on for a preseason league by arguing from a tab that knows nothing about season state. The preseason hide wins regardless of what any caller asks for; `visible` only matters once the season is not.
export function setTimeframeVisible(visible) {
    const toggle = document.getElementById('timeframe-toggle');
    if (!toggle) return;
    const hide = !visible || isPreseason(seasonState(AppState.apiData));
    toggle.classList.toggle('timeframe-hidden', hide);
}

function renderTimeframeToggle(options) {
    const toggle = document.getElementById('timeframe-toggle');
    toggle.innerHTML = '';

    // Two segmented groups rather than one long pill run: the left picks WHICH PART of the season, the right picks HOW RECENT a stretch. They are different questions, and running them together is what made the row read as seven equal choices and overflow once playoffs added a pill. The right group carries a caption naming the unit, which is what lets its pills read Current, Last 4, Last 8 rather than repeating "Matchups" four times. It follows the league's own timeline unit, so a roto league reads "Week".
    const seg = (name) => {
        const el = document.createElement('div');
        el.className = `timeframe-seg timeframe-seg-${name}`;
        return el;
    };
    const groups = { span: seg('span'), recent: seg('recent') };
    toggle.appendChild(groups.span);
    const caption = document.createElement('span');
    caption.className = 'timeframe-caption';
    caption.textContent = axisUnit().long;
    toggle.appendChild(caption);
    toggle.appendChild(groups.recent);

    options.forEach(opt => {
        const btn = document.createElement('button');
        btn.type = 'button';
        // Each segment shows its own half of the answer: the span pill for the part of the season, the window pill for the stretch, and no window pill lit means the whole span. The two ahead pills (O27/S30) answer a THIRD, independent question - AppState.ahead, never AppState.timeframe - so their lit state is read off that field instead.
        const cur = parseTimeframe(AppState.timeframe);
        const isActive = opt.aheadKey ? AppState.ahead === opt.aheadKey
            : (opt.group === 'recent' ? cur.window === opt.window : cur.span === opt.value);
        btn.className = 'timeframe-chip' + (isActive ? ' active' : '') + (opt.disabled ? ' disabled' : '');
        btn.disabled = !!opt.disabled;
        btn.textContent = opt.text;
        // The full, unabbreviated wording (e.g. "Last 4 matchups") on hover - see the label shortening comment above rebuildTimeframeOptions' options array.
        btn.title = opt.title || opt.text;
        btn.dataset.value = opt.value;
        (groups[opt.group] || groups.span).appendChild(btn);
        if (opt.disabled) return;
        btn.addEventListener('click', () => {
            // An ahead pill toggles AppState.ahead directly - it shares the row but not the timeframe value, so it takes its own branch before any of the span/window logic below runs. Same unclick idiom as the window pills: clicking the active one clears it.
            if (opt.aheadKey) {
                AppState.ahead = AppState.ahead === opt.aheadKey ? null : opt.aheadKey;
                rebuildTimeframeOptions();
                handleTimeframeChange();
                return;
            }
            // A window pill toggles. Clicking the active one drops back to the whole span, which is how "the whole regular season" stays reachable without spending a pill on saying so. A span pill carries the current window across, so switching Regular Season to Playoffs keeps you on "last 4" rather than silently widening the view.
            const cur = parseTimeframe(AppState.timeframe);
            let next;
            if (AppState.isRotoLeague) {
                // ROTO'S PILLS DO NOT COMPOSE. Every other league type offers two segmented controls that combine - a season span and a recent window, so "the last 4 of the regular season" is expressible. Roto has no season spans at all: it has one official standing and a set of lookback windows over it, so its row is a plain single-select and its options carry no `group`. Without this branch they fell through to the span arm, which carries the current WINDOW across - so clicking Last 4 while on Current produced "last4+last1", a value no pill matches and no reader asked for. It never surfaced before because the row was being destroyed on every roto click anyway (see rebuildTimeframeOptions).
                next = opt.value;
            } else if (opt.group === 'recent') {
                next = cur.window === opt.window ? cur.span : `${cur.span}+last${opt.window}`;
            } else {
                next = cur.window ? `${opt.value}+last${cur.window}` : opt.value;
            }
            if (AppState.timeframe === next) return;
            AppState.timeframe = next;
            rebuildTimeframeOptions();
            handleTimeframeChange();
        });
    });
}

// Roto timeframe pills are decided ONCE, when the started-day harvest finally lands. Every other league type builds its pill row synchronously in rebuildTimeframeOptions, but roto windows are only honest on started-day data, which arrives asynchronously - so the row starts hidden (rebuildTimeframeOptions) and this promotes it to shown the first time the started tier is ready. Called from the weekly-progress hook (main.js), which fires on every chunk AND on harvest completion; the rotoPillsShown guard makes it a no-op after the first real build, so the pills never flicker and a window the user has since selected is never torn back down to "Full Season".
let rotoPillsShown = false;
export function syncRotoTimeframePills() {
    if (!AppState.isRotoLeague || rotoPillsShown) return;
    const sport = AppState.loadedSport;
    if (!rotoWindowsAvailable(sport)) return; // still on a fallback tier, or harvest not done - stay hidden

    const toggleEl = document.getElementById('timeframe-toggle');
    if (!toggleEl) return;

    // Full Season stays the default and shows ESPN's OFFICIAL standings verbatim (never a computed window). The lookback pills re-score the categories over ONLY that window's started-day components. Roto has no matchup periods, so windows are day-buckets grouped to WEEKS and labelled by week, the same convention as the Roto Race's x-axis. A window is only offered when the season is longer than it, so it always means something different from the full season.
    const maxWeek = rotoWindowMaxWeek(sport);
    // GROUPED LIKE EVERY OTHER FORMAT'S ROW. The pills used to carry no `group`, so all of them fell into the SPAN segment and the "Week" caption - which belongs between the two segments - trailed off the end of the row. A fifth pill pushed it past the right edge and clipped it. Roto's one official standing is the span; its lookbacks are the recent windows. Saying so puts the caption where it belongs and makes the row read the way the other formats' rows do, which is the whole point of standardizing Current across them.
    const options = [{ value: 'all', text: 'Full Season', title: "ESPN's official season standings", group: 'span' }];
    // Same past-to-future axis as the H2H row (S30b): the lookbacks lead, Current sits at the present, then the two ahead pills - Next always structurally disabled for roto (aheadReasons itself), Rest of season live whenever a pro schedule is in hand, since it needs no matchup at all - just today through the league's final period off the club schedule.
    [12, 8, 4].forEach(n => {
        if (maxWeek > n) options.push({ value: `last${n}`, text: `Last ${n} Weeks`, group: 'recent', window: n });
    });
    // CURRENT, which roto did not offer at all until - the pill row went Full Season straight to Last 4, so the one window every other format opens on was the one roto could not select. It is the same last1 window the other formats use, named the same way, in the same position in the row. Offered only once the season is longer than a week, on the same "a window has to mean something different from the full season" rule the lookbacks follow. It is also what makes the day-level roto surfaces reachable: both the Roto Race and the category race under the ranking bars already had a window === 1 branch that drew days, and with no Current pill neither branch could ever run.
    if (maxWeek > 1) options.push({ value: 'last1', text: 'Current', title: 'The current week, day by day', group: 'recent', window: 1 });
    // S30b (owner ruling): roto gets both ahead pills too - Next always greyed with the honest structural reason (aheadReasons sets it unconditionally for a roto league, ahead of any schedule check), Rest of season live/greyed the ordinary schedule-existence way. A pill that exists and says why beats one that is missing without a word, so this row is no longer hidden just because the season is too short for a lookback - Next/Rest give it something honest to show even then.
    const ahead = aheadReasons();
    options.push({
        value: '__ahead_next', group: 'recent', aheadKey: 'next', disabled: !!ahead.next,
        text: 'Next', title: ahead.next || 'Your next matchup, projected'
    });
    options.push({
        value: '__ahead_rest', group: 'recent', aheadKey: 'rest', disabled: !!ahead.rest,
        text: 'Rest of season', title: ahead.rest || 'The rest of the season from today, projected'
    });

    toggleEl.style.display = '';
    renderTimeframeToggle(options); // AppState.timeframe is still 'all', so Full Season starts active
    rotoPillsShown = true;
}

// Moves the.active class to whichever chip matches the newly-selected value - a click only ever changes which ONE button is highlighted, so there's no need to tear down and recreate every button (and re-attach every listener) in the row the way a real option-set rebuild (rebuildTimeframeOptions, e.g. after a new league/season fetch) legitimately does.
function setActiveTimeframeChip(toggle, value) {
    toggle.querySelectorAll('.timeframe-chip').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === value);
    });
}

// The one control that survived the picker's removal. Category Rankings cycles ONE category per screen now, so there is nothing to tick; this only decides whether the cycle covers the league's scored categories or everything ESPN tracks for the sport. It lives in the Rankings box header, in the slot the Bar/Pie selector vacates in Category view, so it costs no layout. It stays VISIBLE rather than silently following AppState.showAdvancedStats (which the Player Metrics tab also writes). Without a control here, a toggle on another tab would quietly change how many categories this box's arrows cycle through, which is exactly the kind of action-at-a-distance the pager's "n / m" indicator would then be reporting with no explanation.
export function renderCategoryAdvancedToggle() {
    const container = document.getElementById('cat-advanced-toggle');
    if (!container) return;
    const sport = AppState.loadedSport;
    const advancedCount = advancedCategoryCount(sport);

    if (advancedCount === 0) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = `
        <label><input type="checkbox" id="cat-advanced-checkbox"${AppState.showAdvancedStats ? ' checked' : ''}> Advanced Stats (${advancedCount})</label>
    `;
    container.querySelector('#cat-advanced-checkbox').addEventListener('change', (e) => {
        AppState.showAdvancedStats = e.target.checked;
        // The cycle just got longer or shorter. renderCategoryBlocks re-resolves the viewed category by STAT ID, so the box stays on whatever it was showing whenever that category is still in the list, and falls back to the first one when the toggle just removed it.
        renderLeftColumn();
    });
}

export function buildLegend() {
    const legendContainer = document.getElementById('team-legend');
    legendContainer.innerHTML = '';

    AppState.teamStats.forEach((t) => {
        const color = AppState.teamColorMap[t.id];
        const label = document.createElement('label');
        label.className = 'legend-item';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = AppState.visibleTeams.has(t.id);

        checkbox.addEventListener('change', (e) => {
            if (e.target.checked) AppState.visibleTeams.add(t.id);
            else AppState.visibleTeams.delete(t.id);
            renderLeftColumn();
            renderRightColumn();
            renderHeatmapBand();
        });

        const colorBox = document.createElement('span');
        colorBox.className = 'legend-color';
        colorBox.style.backgroundColor = color;

        // Name in its own span (not a bare text node) so a long team name ellipsis-truncates within its grid column instead of overflowing into the next one; title shows it in full.
        const name = document.createElement('span');
        name.className = 'legend-name';
        name.textContent = t.name;
        name.title = t.name;

        label.appendChild(checkbox);
        label.appendChild(colorBox);
        label.appendChild(name);
        legendContainer.appendChild(label);
    });
}
