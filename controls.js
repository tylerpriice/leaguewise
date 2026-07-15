import { AppState, ESPN_STAT_MAPS, PITCHING_IDS, GOALIE_IDS } from './state.js';
import { splitScoredAdvanced } from './utils.js';
import { renderLeftColumn, renderRightColumn, renderHeatmapBand } from './graphs.js';
import { renderPlayerLeaderboard, refreshOpenPlayerDetail } from './players.js';

// AppState.timeframe is now the ONE shared selection driving Team Metrics graphs, the Player Metrics leaderboard, the player drill-down chart, and its rank chips/breakdown all at once. Refresh whichever of those currently have data loaded/open, regardless of which tab is active, so switching tabs never shows stale data for the newly-selected timeframe.
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
}


// Collapses the sport/league/year/fetch fields behind the small gear button once data has loaded (see processCoreData in data.js). They're one-time setup, not worth permanent header space.
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

// Replaced simple label update with dynamic option reconstruction for Playoffs forceDefault is set on a genuine new-season fetch (see processCoreData). Otherwise a selection made on a playoff-less season (which falls back to "reg", see below) would silently carry over and stay stuck on "reg" for the NEXT season fetched too, even one that does have playoffs, hiding its postseason bars for no visible reason.
export function rebuildTimeframeOptions(forceDefault = false) {
    const maxWk = AppState.maxCompletedWeek;
    const regWks = AppState.regSeasonWeeks;
    const hasPlayoffs = maxWk > regWks;

    // "Full Season"/"Regular Season" are kept short (dropping "+ Playoffs" / "Only") so the pill row has room for the "Matchups" word on every lookback window below, which is worth calling out explicitly: every window in this app is in MATCHUP units, not real calendar weeks (a playoff matchup can span 2-3 real weeks, since ESPN folds multi-week championship rounds into one matchup). Dropping "Matchups" read as ambiguous, so it stays in the visible label rather than being demoted to a hover-only tooltip.
    const options = [];
    // "Full Season" only means something DIFFERENT from "Regular Season" once playoffs have actually started. Before that they'd be identical, so skip it entirely.
    if (hasPlayoffs) options.push({ value: 'all', text: 'Full Season', title: 'Regular Season + Playoffs' });
    options.push({ value: 'reg', text: 'Regular Season' });

    // Playoffs sits directly after Regular Season (before the recent-window options), so the pill row reads Full Season -> Regular Season -> Playoffs -> This Matchup -> Last N.
    if (hasPlayoffs) options.push({ value: 'p_all', text: 'Playoffs' });

    // Fixed lookback windows instead of a percentage of the season. Simpler to read, and doesn't depend on knowing the real season length.
    [1, 4, 8, 12].forEach(n => {
        if (maxWk > n) options.push({ value: `last${n}`, text: n === 1 ? 'This Matchup' : `Last ${n} Matchups` });
    });

    const currentVal = forceDefault ? null : AppState.timeframe;
    const fallback = hasPlayoffs ? 'all' : 'reg';
    AppState.timeframe = options.some(o => o.value === currentVal) ? currentVal : fallback;

    renderTimeframeToggle(options);
}

// A row of always-visible pill buttons (same visual language as .filter-flex/.legend-item elsewhere in this file). Lives directly in .tabs-container (dashboard.html) so it's visible regardless of which tab is active.
function renderTimeframeToggle(options) {
    const toggle = document.getElementById('timeframe-toggle');
    toggle.innerHTML = '';

    options.forEach(opt => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'timeframe-chip' + (opt.value === AppState.timeframe ? ' active' : '');
        btn.textContent = opt.text;
        // The full, unabbreviated wording (e.g, "Last 4 matchups") on hover. See the label shortening comment above rebuildTimeframeOptions' options array.
        btn.title = opt.title || opt.text;
        btn.dataset.value = opt.value;
        btn.addEventListener('click', () => {
            if (AppState.timeframe === opt.value) return;
            AppState.timeframe = opt.value;
            setActiveTimeframeChip(toggle, opt.value);
            handleTimeframeChange();
        });
        toggle.appendChild(btn);
    });
}

// Moves the .active class to whichever chip matches the newly-selected value. A click only ever changes which ONE button is highlighted, so there's no need to tear down and recreate every button (and re-attach every listener) in the row the way a real option-set rebuild (rebuildTimeframeOptions, e.g, after a new league/season fetch) legitimately does.
function setActiveTimeframeChip(toggle, value) {
    toggle.querySelectorAll('.timeframe-chip').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === value);
    });
}

function renderTeamAdvancedToggle(advancedCount) {
    const container = document.getElementById('team-advanced-toggle');
    if (!container) return;

    if (advancedCount === 0) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = `
        <label><input type="checkbox" id="team-advanced-checkbox"${AppState.showAdvancedStats ? ' checked' : ''}> Advanced Stats (${advancedCount})</label>
    `;
    container.querySelector('#team-advanced-checkbox').addEventListener('change', (e) => {
        AppState.showAdvancedStats = e.target.checked;
        buildCheckboxes();
    });
}

export function buildCheckboxes() {
    const sport = document.getElementById('sport').value;
    const container = document.getElementById('category-checkboxes');
    if (AppState.isPointsLeague || AppState.availableStatsSet.size === 0) return;

    const statMap = ESPN_STAT_MAPS[sport] || {};
    const checkedStats = new Set(Array.from(document.querySelectorAll('.cat-check:checked')).map(cb => cb.value));
    container.innerHTML = '';

    const allStats = [];
    const seen = new Set();

    Array.from(AppState.availableStatsSet).forEach((statId) => {
        const statName = statMap[statId] || `Stat [${statId}]`;
        if (seen.has(statName)) return;
        seen.add(statName);
        allStats.push({ id: statId, name: statName });
    });

    // Only show the categories this league's own settings actually score by default. The rest is tucked behind the Advanced Stats toggle, same as the Player Metrics tab.
    const { scored, advanced } = splitScoredAdvanced(allStats.map(s => s.id));
    // Category Rankings is its own always-visible column now. Default to the first scored category on a fresh build (nothing previously checked) so that panel isn't empty.
    if (checkedStats.size === 0 && scored.length > 0) checkedStats.add(scored[0].toString());
    const visibleIds = new Set(AppState.showAdvancedStats ? [...scored, ...advanced] : scored);
    renderTeamAdvancedToggle(advanced.length);

    const group1 = [];
    const group2 = [];
    allStats.filter(s => visibleIds.has(s.id)).forEach((obj) => {
        if ((sport === 'flb' && PITCHING_IDS.has(obj.id.toString())) ||
            (sport === 'fhl' && GOALIE_IDS.has(obj.id.toString()))) {
            group2.push(obj);
        } else {
            group1.push(obj);
        }
    });

    const catFiltersContent = container.parentElement;
    let warningEl = document.getElementById('cat-limit-warning');
    if (!warningEl) {
        warningEl = document.createElement('div');
        warningEl.id = 'cat-limit-warning';
        warningEl.style.cssText = 'color: var(--danger); font-size: 11px; margin-bottom: 8px; font-weight: bold; display: none;';
        warningEl.textContent = '🔒 Limit reached: Maximum of 2 categories can be compared at once.';
        catFiltersContent.insertBefore(warningEl, container);
    }

    let currentChecked = 0;

    const updateCheckboxStates = () => {
        const activeCount = document.querySelectorAll('.cat-check:checked').length;
        warningEl.style.display = activeCount >= 2 ? 'block' : 'none';

        document.querySelectorAll('.cat-check').forEach(cb => {
            if (!cb.checked) {
                cb.disabled = activeCount >= 2;
                cb.parentElement.style.opacity = activeCount >= 2 ? '0.4' : '1';
            } else {
                cb.disabled = false;
                cb.parentElement.style.opacity = '1';
            }
        });
    };

    const renderCbs = (arr, labelText) => {
        if (arr.length === 0) return;
        const hdr = document.createElement('div');
        hdr.textContent = labelText;
        hdr.style.cssText = "grid-column: 1 / -1; font-weight: bold; color: var(--text-body); margin: 4px 0 2px 0;";
        container.appendChild(hdr);

        arr.forEach(stat => {
            const label = document.createElement('label');
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'cat-check';
            cb.value = stat.id;
            cb.dataset.name = stat.name;

            if (checkedStats.has(stat.id.toString()) && currentChecked < 2) {
                cb.checked = true;
                currentChecked++;
            }

            cb.addEventListener('change', () => {
                updateCheckboxStates();
                // Category Rankings moved into the Rankings box (left column's category view).
                renderLeftColumn();
            });

            label.appendChild(cb);
            label.appendChild(document.createTextNode(stat.name));
            container.appendChild(label);
        });
    };

    renderCbs(group1, sport === 'flb' ? '🏏 Batting' : '🏒 Skaters');
    if (group2.length > 0) {
        const hr = document.createElement('div');
        hr.style.cssText = "grid-column: 1 / -1; border-top: 1px solid var(--border-strong); margin: 6px 0;";
        container.appendChild(hr);
        renderCbs(group2, sport === 'flb' ? '⚾ Pitching' : '🥅 Goalies');
    }

    updateCheckboxStates();
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

        // Name in its own span (not a bare text node) so a long team name ellipsis-truncates within its grid column instead of overflowing into the next one. Title shows it in full.
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