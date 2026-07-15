import { checkAuth, loadStoredSettings, fetchEspnData } from './api.js';
import { renderLeftColumn, renderRightColumn, renderHeatmapBand } from './graphs.js';
import { AppState } from './state.js';
import { loadPlayerTabIfNeeded, renderPlayerLeaderboard, openPlayerDetail } from './players.js';
import { downloadDebugData, setActiveDebugKind, refreshDebugPanel } from './utils.js';
import { openExportModal } from './export.js';
import { openRecapModal } from './recap.js';

// Theme cycle: Auto (follow prefers-color-scheme) → Light → Dark.
function setupThemeToggle() {
    const btn = document.getElementById('theme-toggle-btn');
    if (!btn) return;
    const MODES = ['auto', 'light', 'dark'];
    const ICON = { auto: '🌗', light: '☀️', dark: '🌙' };
    const LABEL = { auto: 'Theme: Auto (match system). Click for Light', light: 'Theme: Light. Click for Dark', dark: 'Theme: Dark. Click for Auto' };
    const read = () => {
        try { const t = localStorage.getItem('efv-theme'); return (t === 'light' || t === 'dark') ? t : 'auto'; }
        catch { return 'auto'; }
    };
    const apply = (mode) => {
        if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', mode);
        try {
            if (mode === 'auto') localStorage.removeItem('efv-theme');
            else localStorage.setItem('efv-theme', mode);
        } catch { /* private mode / storage disabled - theme still applies for this session */ }
        btn.textContent = ICON[mode];
        btn.title = LABEL[mode];
    };
    apply(read());
    btn.addEventListener('click', () => apply(MODES[(MODES.indexOf(read()) + 1) % MODES.length]));
}

document.addEventListener('DOMContentLoaded', async () => {

    // Redirect to a full tab if opened as a small popup (width < 800px). But ONLY on the first, untagged load.
    const isTaggedTab = new URLSearchParams(location.search).has('tab');
    if (!isTaggedTab && window.innerWidth < 800) {
        browser.tabs.create({ url: browser.runtime.getURL("dashboard.html") + "?tab=1" });
        window.close();
        return;
    }

    // Theme toggle is independent of league data. Wire it first so it works immediately.
    setupThemeToggle();

    // 1. Initial Checks & Load Data
    await checkAuth();
    await loadStoredSettings();

    // 2. Main API Binding
    document.getElementById('fetch-btn').addEventListener('click', async () => {
        // A player drilled into before the fetch is about to have its cached weekly stats wiped by processCoreData(). Grab its id now so it can be reopened with fresh data for whatever year was just fetched, instead of being left showing the old year.
        const reopenPlayerId = AppState.selectedPlayerId;

        await fetchEspnData();
        // processCoreData() already invalidated the cached player pool (new year/league/sport), but if Player Metrics is the tab currently on screen, nothing else re-triggers a reload until the tab is clicked again. Refresh it immediately instead of leaving the previous fetch's stale leaderboard showing.
        const playerView = document.getElementById('view-player');
        if (playerView && playerView.style.display !== 'none') {
            await loadPlayerTabIfNeeded();
            if (reopenPlayerId !== null) openPlayerDetail(reopenPlayerId, true);
        }
    });

    // 3.
    document.getElementById('settings-toggle-btn').addEventListener('click', () => {
        document.getElementById('settings-bar').classList.toggle('collapsed');
    });
    document.getElementById('toggle-cat').addEventListener('change', renderRightColumn);
    document.getElementById('toggle-match').addEventListener('change', renderRightColumn);
    document.getElementById('pie-selector').addEventListener('change', renderLeftColumn);

    // The Rankings box's header tabs switch it between Team Rankings (standings bars + pies) and Category Rankings (+ its category picker).
    const setRankingsBoxView = (view) => {
        if (AppState.rankingsBoxView === view) return;
        AppState.rankingsBoxView = view;
        renderLeftColumn();
    };
    document.getElementById('rankings-tab-standings').addEventListener('click', () => setRankingsBoxView('standings'));
    document.getElementById('rankings-tab-category').addEventListener('click', () => setRankingsBoxView('category'));

    // Collapsible Filters box (closed by default), now a full-width bar at the bottom of the tab. Toggling it changes how much vertical space the three top columns get, so re-fit all of them (standings + trends + rankings).
    document.getElementById('filters-toggle').addEventListener('click', () => {
        const panel = document.getElementById('control-panel');
        const collapsed = panel.classList.toggle('collapsed');
        document.getElementById('filters-toggle').setAttribute('aria-expanded', String(!collapsed));
        renderLeftColumn();
        renderRightColumn();
    });

    // 4.
    let searchDebounceId = null;
    document.getElementById('player-search').addEventListener('input', (e) => {
        AppState.playerSearchQuery = e.target.value;
        clearTimeout(searchDebounceId);
        searchDebounceId = setTimeout(renderPlayerLeaderboard, 200);
    });
    document.getElementById('player-position-filter').addEventListener('change', (e) => {
        AppState.playerPositionFilter = e.target.value;
        renderPlayerLeaderboard();
    });
    document.getElementById('player-availability-filter').addEventListener('change', (e) => {
        AppState.playerAvailabilityFilter = e.target.value;
        renderPlayerLeaderboard();
    });

    // Export/Recap live in the tab bar (inside #results, so they only appear once data has loaded). Both modals re-read current state on every open, so no other wiring is needed.
    document.getElementById('export-btn').addEventListener('click', openExportModal);
    document.getElementById('recap-btn').addEventListener('click', openRecapModal);

    // 5. Debug Panel Bindings
    document.getElementById('debug-download-btn').addEventListener('click', downloadDebugData);
    // The panel's own <details> lazily skips serializing its payload while collapsed (see setDebugContext/renderActiveDebugContext in utils.js). Catch it up whenever it's opened, in case its active context changed in the background while it sat collapsed.
    document.getElementById('debug-panel').addEventListener('toggle', refreshDebugPanel);

    // 6. Tab Navigation Bindings
    const tabBtnTeam = document.getElementById('tab-btn-team');
    const tabBtnPlayer = document.getElementById('tab-btn-player');
    const viewTeam = document.getElementById('view-team');
    const viewPlayer = document.getElementById('view-player');

    function switchTab(name) {
        const isTeam = name === 'team';
        tabBtnTeam.classList.toggle('active', isTeam);
        tabBtnPlayer.classList.toggle('active', !isTeam);
        viewTeam.style.display = isTeam ? 'flex' : 'none';
        viewPlayer.style.display = isTeam ? 'none' : 'flex';
        if (isTeam) {
            setActiveDebugKind('team');
            // Re-render on return: the columns' layout-measuring steps (inline-pie placement, compact-row fallback, see renderLeftColumn/renderCategoryGraph in graphs.js) read zero heights for anything measured while this tab was display:none, silently dropping the inline pies until some other re-render happened to run while visible.
            if (AppState.apiData) {
                renderLeftColumn();
                renderRightColumn();
                renderHeatmapBand();
            }
        } else {
            // A drill-down left open from a previous visit stays open (loadPlayerTabIfNeeded only touches the leaderboard container). Match the panel to whichever is actually showing rather than always assuming the leaderboard.
            setActiveDebugKind(AppState.selectedPlayerId !== null ? 'player-detail' : 'player-pool');
            loadPlayerTabIfNeeded();
        }
    }

    tabBtnTeam.addEventListener('click', () => switchTab('team'));
    tabBtnPlayer.addEventListener('click', () => switchTab('player'));
});