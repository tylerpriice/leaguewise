import { AppState } from './state.js';
import { advancedCategoryCount, axisUnit, parseTimeframe } from './utils.js';
import { renderLeftColumn, renderRightColumn, renderHeatmapBand } from './graphs.js';
import { renderPlayerLeaderboard, refreshOpenPlayerDetail, rotoWindowsAvailable, rotoWindowMaxWeek } from './players.js';
import { renderMyTeamTab } from './myteam.js';

// One timeframe drives both tabs, so refresh whichever views have data loaded regardless of which tab is active.
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
    // My Team windows with the same pills: its roster lines, its ranks and its standing all read the current timeframe, so it re-renders here rather than waiting for a tab switch.
    if (AppState.apiData) renderMyTeamTab();
}


// Collapses the one-time setup fields behind the gear button once data has loaded. The gear replays a short jump while they are collapsed so it stays obvious where they went.
const GEAR_REMINDER_HOP_MS = 60000;
let settingsJumpPlayed = false;
let gearReminderTimer = null;

function playGearJump(btn) {
    // Remove and reflow so the animation restarts even if the class is already present.
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

// forceDefault only on a genuine new-season fetch. Otherwise a selection made on a playoff-less season stays stuck for the next season fetched, hiding its postseason bars.
export function rebuildTimeframeOptions(forceDefault = false) {
    // Roto has no matchup periods and ESPN serves one cumulative standing, so windows are only possible once the started-day harvest lands. Start hidden and season-only on every fetch.
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

    // Every window here is in MATCHUP units, not calendar weeks: ESPN folds a multi-week championship round into one matchup.
    const options = [];
    // Full Season only means something different from Regular Season once playoffs have started.
    if (hasPlayoffs) options.push({ value: 'all', text: 'Full Season', title: 'Regular Season + Playoffs', group: 'span' });
    options.push({ value: 'reg', text: 'Regular Season', group: 'span' });

    if (hasPlayoffs) options.push({ value: 'p_all', text: 'Playoffs', group: 'span' });

    // Fixed lookback windows, offered only when more season sits outside the window than inside it. n=1 is the live matchup, since maxCompletedWeek counts one in progress.

    // A window only applies when the span it sits in is longer than the window itself, since "last 8" inside a three-matchup playoff bracket is the whole bracket. The pill still renders, disabled: removing it changes the strip's width, and the strip is centred between the tabs and the utilities, so every pill in the row would jump sideways on a span click.
    const spanLength = (span) => {
        if (span === 'reg') return Math.min(maxWk, regWks);
        if (span === 'p_all') return Math.max(0, maxWk - regWks);
        return maxWk;
    };
    const activeSpan = parseTimeframe(AppState.timeframe).span;
    const spanValues = options.map(o => o.value);
    const span = spanValues.includes(activeSpan) ? activeSpan : (hasPlayoffs ? 'all' : 'reg');
    const unit = axisUnit();
    // The group caption carries the unit, so no pill in it repeats the word: Current, Last 4, Last 8, Last 12 under one heading. group marks which segment a pill belongs to, the season span on the left and the recent stretch on the right.
    [1, 4, 8, 12].forEach(n => {
        if (maxWk <= n) return;
        const fits = spanLength(span) > n;
        options.push({
            value: `${span}+last${n}`, group: 'recent', window: n, disabled: !fits,
            text: n === 1 ? 'Current' : `Last ${n}`,
            title: !fits
                ? `Only ${spanLength(span)} ${unit.plural.toLowerCase()} in this stretch`
                : (n === 1 ? `The ${unit.long.toLowerCase()} being played now` : `The last ${n} completed ${unit.plural.toLowerCase()}`)
        });
    });

    const currentVal = forceDefault ? null : AppState.timeframe;
    const fallback = hasPlayoffs ? 'all' : 'reg';
    // A window the new span cannot offer costs the window, not the span. Switching to a four-matchup bracket while holding "last 4" should not throw both away and land back on the full season.
    const spanOnly = currentVal ? parseTimeframe(currentVal).span : null;
    const live = (val) => options.some(o => o.value === val && !o.disabled);
    AppState.timeframe = live(currentVal) ? currentVal : (live(spanOnly) ? spanOnly : fallback);

    renderTimeframeToggle(options);
}

// The pill row lives in the tab bar so it stays visible on both tabs. AppState.timeframe is the source of truth, there is no backing select.
function renderTimeframeToggle(options) {
    const toggle = document.getElementById('timeframe-toggle');
    toggle.innerHTML = '';

    // Two segmented groups rather than one long pill run: the left picks which part of the season, the right picks how recent a stretch. They are different questions, and running them together read as one row of equal choices.
    const seg = (name) => {
        const el = document.createElement('div');
        el.className = `timeframe-seg timeframe-seg-${name}`;
        return el;
    };
    const groups = { span: seg('span'), recent: seg('recent') };
    toggle.appendChild(groups.span);
    // The right group carries a caption naming the unit, which is what lets its pills read Current, Last 4, Last 8 rather than repeating the word four times. It follows the league's own timeline unit, so a roto league reads Week.
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
        // The unabbreviated wording on hover.
        btn.title = opt.title || opt.text;
        btn.dataset.value = opt.value;
        (groups[opt.group] || groups.span).appendChild(btn);
        if (opt.disabled) return;
        btn.addEventListener('click', () => {
            // A window pill toggles, so clicking the lit one drops back to the whole span, which is how that stays reachable without spending a pill on saying so. A span pill carries the current window across instead of silently widening the view.
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

// Roto pills are decided once, when the started-day harvest lands. The guard keeps the row from flickering as chunks stream in, and from resetting a window the user has already picked.
let rotoPillsShown = false;
export function syncRotoTimeframePills() {
    if (!AppState.isRotoLeague || rotoPillsShown) return;
    const sport = AppState.loadedSport;
    if (!rotoWindowsAvailable(sport)) return; // still on a fallback tier, or harvest not done, stay hidden

    const toggleEl = document.getElementById('timeframe-toggle');
    if (!toggleEl) return;

    // Full Season shows ESPN's official standings verbatim. The lookback pills re-score the categories over that window's started-day components, bucketed to weeks.
    const maxWeek = rotoWindowMaxWeek(sport);
    const options = [{ value: 'all', text: 'Full Season', title: "ESPN's official season standings" }];
    [4, 8, 12].forEach(n => {
        if (maxWeek > n) options.push({ value: `last${n}`, text: `Last ${n} Weeks` });
    });
    if (options.length === 1) return; // season too short for any honest window, keep the row hidden

    toggleEl.style.display = '';
    renderTimeframeToggle(options); // AppState.timeframe is still 'all', so Full Season starts active
    rotoPillsShown = true;
}

// Only the active class moves, so a click does not tear down and re-attach every button in the row.
function setActiveTimeframeChip(toggle, value) {
    toggle.querySelectorAll('.timeframe-chip').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === value);
    });
}

// Category Rankings cycles one category per screen, so this only decides whether the cycle covers the league's scored categories or everything ESPN tracks for the sport. It stays visible because the Player Metrics tab writes the same state.
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
        // renderCategoryBlocks re-resolves the viewed category by stat id, so the box holds its place when the list gets longer or shorter.
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

        // The name sits in its own span so a long team name truncates inside its grid column instead of overflowing.
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
