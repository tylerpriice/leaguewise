import { AppState } from './state.js';
import { advancedCategoryCount, axisUnit, parseTimeframe } from './utils.js';
import { renderLeftColumn, renderRightColumn, renderHeatmapBand } from './graphs.js';
import { renderPlayerLeaderboard, refreshOpenPlayerDetail, rotoWindowsAvailable, rotoWindowMaxWeek } from './players.js';
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
    // Roto has no matchup periods, and ESPN only ever serves ONE cumulative season standing - so at league-load time the only honest view is the full season. Windows become possible only once the started-day snapshot harvest lands, which happens asynchronously after this runs; syncRotoTimeframePills below adds the pills THEN, exactly once, so the row never appears/disappears/relabels while the harvest streams in (: the ladder is for failure, not latency). Start hidden and season-only every fetch; the reset here lets a new league re-decide.
    const toggleEl = document.getElementById('timeframe-toggle');
    if (AppState.isRotoLeague) {
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
    [1, 4, 8, 12].forEach(n => {
        if (maxWk <= n) return;
        const fits = spanLength(span) > n;
        options.push({
            value: `${span}+last${n}`, group: 'recent', window: n, disabled: !fits,
            text: n === 1 ? 'Current' : `Last ${n}`,
            title: !fits
                ? `Only ${spanLength(span)} ${(spanLength(span) === 1 ? unit.long : unit.plural).toLowerCase()} in this stretch, so there is no window to take inside it`
                : (n === 1 ? `The ${unit.long.toLowerCase()} being played now` : `The last ${n} completed ${unit.plural.toLowerCase()}`)
        });
    });

    const currentVal = forceDefault ? null : AppState.timeframe;
    const fallback = hasPlayoffs ? 'all' : 'reg';
    // A window that the NEW span cannot offer costs the window, not the span. Switching to a four-matchup playoff bracket while holding "last 4" used to throw both away and land back on Full Season, which is not what either click asked for.
    const spanOnly = currentVal ? parseTimeframe(currentVal).span : null;
    const live = (val) => options.some(o => o.value === val && !o.disabled);
    AppState.timeframe = live(currentVal) ? currentVal : (live(spanOnly) ? spanOnly : fallback);

    renderTimeframeToggle(options);
}

// A row of always-visible pill buttons (same visual language as.filter-flex/.legend-item elsewhere in this file) - lives directly in.tabs-container (dashboard.html) so it's visible regardless of which tab is active. AppState.timeframe is the real source of truth now (no backing <select> anymore - see state.js).
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
        // Each segment shows its own half of the answer: the span pill for the part of the season, the window pill for the stretch, and no window pill lit means the whole span.
        const cur = parseTimeframe(AppState.timeframe);
        const isActive = opt.group === 'recent' ? cur.window === opt.window : cur.span === opt.value;
        btn.className = 'timeframe-chip' + (isActive ? ' active' : '') + (opt.disabled ? ' disabled' : '');
        btn.disabled = !!opt.disabled;
        btn.textContent = opt.text;
        // The full, unabbreviated wording (e.g. "Last 4 matchups") on hover - see the label shortening comment above rebuildTimeframeOptions' options array.
        btn.title = opt.title || opt.text;
        btn.dataset.value = opt.value;
        (groups[opt.group] || groups.span).appendChild(btn);
        if (opt.disabled) return;
        btn.addEventListener('click', () => {
            // A window pill toggles. Clicking the active one drops back to the whole span, which is how "the whole regular season" stays reachable without spending a pill on saying so. A span pill carries the current window across, so switching Regular Season to Playoffs keeps you on "last 4" rather than silently widening the view.
            const cur = parseTimeframe(AppState.timeframe);
            let next;
            if (opt.group === 'recent') {
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
    const options = [{ value: 'all', text: 'Full Season', title: "ESPN's official season standings" }];
    [4, 8, 12].forEach(n => {
        if (maxWeek > n) options.push({ value: `last${n}`, text: `Last ${n} Weeks` });
    });
    if (options.length === 1) return; // season too short for any honest window - keep the row hidden

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
