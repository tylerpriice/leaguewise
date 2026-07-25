import { checkAuth, loadStoredSettings, fetchEspnData, setPostFetchHook, renderMyLeaguesOptions } from './api.js';
import { renderLeftColumn, renderRightColumn, renderHeatmapBand, setupCardPopout, isCardPopoutOpen, closeCardPopout } from './graphs.js';
import { AppState } from './state.js';
import { loadPlayerTabIfNeeded, renderPlayerLeaderboard, openPlayerDetail, closePlayerDetail, ensurePlayerDetailDiagnostic, reprioritizeWeeklyQueue, setWeeklyProgressHook } from './players.js';
import { downloadDebugData, setActiveDebugKind, refreshDebugPanel } from './utils.js';
import { openExportModal } from './export.js';
import { openRecapModal } from './recap.js';
import { syncRotoTimeframePills } from './controls.js';

// Theme cycle: Auto follows prefers-color-scheme, then Light, then Dark. The choice is stored in localStorage and re-applied before paint by theme-init.js, and "auto" removes data-theme so the media query drives it again.
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
        } catch { /* private mode / storage disabled, theme still applies for this session */ }
        btn.textContent = ICON[mode];
        btn.title = LABEL[mode];
    };
    apply(read());
    btn.addEventListener('click', () => apply(MODES[(MODES.indexOf(read()) + 1) % MODES.length]));
}

// Every pop-out overlay built by createPopoutController. Both dock the SAME Teams legend node, so opening one closes the others before it claims those nodes.
const popoutControllers = [];

// Shared machinery for the Season Trends and Category Heatmap pop-outs. Both MOVE the real content and filter nodes into the overlay rather than cloning them, so existing event wiring keeps working, which is also why the restore order below matters.
function createPopoutController({ openBtn, closeBtn, overlay, contentSlot, filtersSlot, content, contentHome, filters, filtersHome, titleFrom, onOpen, onClose }) {
    if (!openBtn || !closeBtn || !overlay || !contentSlot || !filtersSlot || !content || !contentHome || !filtersHome) return null;
    if (filters.some(f => !f)) return null;

    const titleEl = overlay.querySelector('.trends-overlay-title');
    let open = false;

    const controller = {
        isOpen: () => open,
        close: () => {
            if (!open) return;
            contentHome.appendChild(content);
            filters.forEach(f => filtersHome.appendChild(f));
            overlay.hidden = true;
            openBtn.setAttribute('aria-expanded', 'false');
            open = false;
            onClose();
        },
        open: () => {
            if (open) return;
            popoutControllers.forEach(other => { if (other !== controller) other.close(); });
            if (titleEl && titleFrom) titleEl.textContent = titleFrom();
            contentSlot.appendChild(content);
            filters.forEach(f => filtersSlot.appendChild(f));
            overlay.hidden = false;
            openBtn.setAttribute('aria-expanded', 'true');
            open = true;
            onOpen();
        }
    };

    openBtn.addEventListener('click', controller.open);
    closeBtn.addEventListener('click', controller.close);
    popoutControllers.push(controller);
    return controller;
}

function setupPopouts() {
    const teamFilters = document.getElementById('team-filters');
    const trendFilters = document.getElementById('trend-filters');
    const filtersHome = document.querySelector('.control-panel-body');

    // Season Trends docks both filter groups so each live-updates the enlarged chart. The timeframe pills stay in the always-visible tab bar and never move.
    createPopoutController({
        openBtn: document.getElementById('trends-popout-btn'),
        closeBtn: document.getElementById('trends-popout-close'),
        overlay: document.getElementById('trends-overlay'),
        contentSlot: document.getElementById('trends-overlay-chart'),
        filtersSlot: document.getElementById('trends-overlay-filters'),
        content: document.getElementById('line-graph-container'),
        contentHome: document.querySelector('.col-trends'),
        filters: [trendFilters, teamFilters],
        filtersHome,
        // The box renames itself to Matchup Scoreboard at a single matchup.
        titleFrom: () => document.getElementById('trends-box-title').textContent,
        // Re-render into the now-larger container: the chart's SVG is sized in percentages over a viewBox, so this draws crisp at the overlay size instead of being scaled up.
        onOpen: () => renderRightColumn(),
        // Fresh measurements for the restored small layout, the same pair of re-fits the Data Filters toggle runs when it changes the height budget.
        onClose: () => { renderLeftColumn(); renderRightColumn(); }
    });

    // The heatmap docks only the Teams legend, since Trend Lines drives a chart that is not in this overlay. Re-rendering on open drops the row cap the small band needs and restores it on close.
    createPopoutController({
        openBtn: document.getElementById('heatmap-popout-btn'),
        closeBtn: document.getElementById('heatmap-popout-close'),
        overlay: document.getElementById('heatmap-overlay'),
        contentSlot: document.getElementById('heatmap-overlay-chart'),
        filtersSlot: document.getElementById('heatmap-overlay-filters'),
        content: document.getElementById('heatmap-graph-container'),
        contentHome: document.querySelector('.heatmap-band'),
        filters: [teamFilters],
        filtersHome,
        onOpen: () => renderHeatmapBand(),
        onClose: () => { renderHeatmapBand(); renderLeftColumn(); renderRightColumn(); }
    });

    // One Escape handler for every overlay. It yields to the legend popover's own Escape close, so one press never does two things.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!popoutControllers.some(c => c.isOpen()) && !isCardPopoutOpen()) return;
        const legendPopover = document.getElementById('legend-popover');
        if (legendPopover && !legendPopover.hidden) return;
        // Closes the TOPMOST surface only. The per-card pop-out can sit over the scoreboard's own pop-out, so while it is up it takes the press and the overlay underneath stays.
        if (isCardPopoutOpen()) {
            closeCardPopout();
            return;
        }
        popoutControllers.forEach(c => c.close());
    });
}

document.addEventListener('DOMContentLoaded', async () => {

    // Redirect to a full tab when opened as a small popup, but only on the first untagged load. On Firefox for Android every surface renders under the width threshold, so without the tag the tab this opens would trip the same check and open another, forever.
    const params = new URLSearchParams(location.search);
    let alreadyTab = params.has('tab');
    try { alreadyTab = alreadyTab || sessionStorage.getItem('lwTab') === '1'; } catch { /* storage disabled, fall back to the URL tag alone */ }
    if (!alreadyTab && window.innerWidth < 800) {
        browser.tabs.create({ url: browser.runtime.getURL("dashboard.html") + "?tab=1" });
        window.close();
        return;
    }
    // On the tagged load, mark this tab and drop only the 'tab' param, so the URL reads clean while any other params survive a reload.
    if (params.has('tab')) {
        try { sessionStorage.setItem('lwTab', '1'); } catch { /* storage disabled, the load still works, only the reload guard is lost */ }
        params.delete('tab');
        const qs = params.toString();
        history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
    }

    // The theme toggle is independent of league data, so wire it first and it works immediately.
    setupThemeToggle();

    // The pop-out overlays are wired once. Their buttons live in a view that only appears after data loads, but the elements exist in the static markup from the start.
    setupPopouts();
    // The per-card pop-out's close button. Its open triggers live on the cards, which are rebuilt on every scoreboard render, so those are wired there.
    setupCardPopout();

    // The Roto Race fills in as the bulk weekly fetch's chunks land, so each debounced repaint re-renders the trends box to pick up newly cached weeks. Gated to roto, and wired here rather than in players.js to keep that import one-directional.
    setWeeklyProgressHook(() => {
        if (!AppState.isRotoLeague) return;
        renderRightColumn();
        syncRotoTimeframePills();
        // The Rankings box has to re-fit too: its category races only become drawable once the series has data, and the pill row appearing changes the height every box is measured against.
        renderLeftColumn();
    });

    // Refresh the Player Metrics view after any successful league fetch. It lives on the shared hook because the My Leagues picker auto-fetches without going near the button handler, which used to leave the leaderboard on the previous league.
    setPostFetchHook(async ({ reopenPlayerId }) => {
        // The cached pool is already invalidated, but if Player Metrics is the tab on screen nothing else re-triggers a reload until it is clicked again.
        const playerView = document.getElementById('view-player');
        if (!playerView || playerView.style.display === 'none') return;
        await loadPlayerTabIfNeeded();
        // Reopen the prior drill-down only if that player is in the NEW league's pool. A year change keeps the id and reopens with fresh data, while a league or sport change closes back to the freshly rendered leaderboard.
        if (reopenPlayerId !== null) {
            if (AppState.playerData.some(p => p.id === reopenPlayerId)) openPlayerDetail(reopenPlayerId, true);
            else closePlayerDetail();
        }
    });

    // 1. Initial checks and load data
    await checkAuth();
    await loadStoredSettings();

    // 2. Main API binding
    document.getElementById('fetch-btn').addEventListener('click', () => fetchEspnData());

    // Re-filter the My Leagues picker to the selected sport from the in-memory list, so hockey leagues never show while Baseball is selected. A no-op before discovery runs.
    document.getElementById('sport').addEventListener('change', renderMyLeaguesOptions);

    // 3. Viewport trigger bindings
    // The gear toggles the collapsed league-settings fields back open, class-based so it eases via the transition.
    document.getElementById('settings-toggle-btn').addEventListener('click', () => {
        document.getElementById('settings-bar').classList.toggle('collapsed');
    });
    document.getElementById('toggle-cat').addEventListener('change', renderRightColumn);
    document.getElementById('toggle-match').addEventListener('change', renderRightColumn);

    // The Rankings box's header tabs switch between Team Rankings and Category Rankings. Only that box re-renders, since Season Trends and the heatmap are unaffected.
    const setRankingsBoxView = (view) => {
        if (AppState.rankingsBoxView === view) return;
        AppState.rankingsBoxView = view;
        renderLeftColumn();
    };
    document.getElementById('rankings-tab-standings').addEventListener('click', () => setRankingsBoxView('standings'));
    document.getElementById('rankings-tab-category').addEventListener('click', () => setRankingsBoxView('category'));

    // The collapsible Filters bar changes how much vertical space the three top columns get, so all of them re-fit. The heatmap band is content-sized and unaffected.
    document.getElementById('filters-toggle').addEventListener('click', () => {
        const panel = document.getElementById('control-panel');
        const collapsed = panel.classList.toggle('collapsed');
        document.getElementById('filters-toggle').setAttribute('aria-expanded', String(!collapsed));
        renderLeftColumn();
        renderRightColumn();
    });

    // Both pop-outs' docked filter boxes collapse the same way. Collapsing hands the height to the chart underneath, so each re-renders its content into the taller slot.
    const wireOverlayFilterToggle = (btnId, panelId, rerender) => {
        const btn = document.getElementById(btnId);
        const panel = document.getElementById(panelId);
        if (!btn || !panel) return;
        btn.addEventListener('click', () => {
            const collapsed = panel.classList.toggle('collapsed');
            btn.setAttribute('aria-expanded', String(!collapsed));
            rerender();
        });
    };
    wireOverlayFilterToggle('heatmap-filters-toggle', 'heatmap-overlay-filters-panel', renderHeatmapBand);
    wireOverlayFilterToggle('trends-filters-toggle', 'trends-overlay-filters-panel', renderRightColumn);

    // 4. Player leaderboard bindings
    // Debounced so a re-filter and re-rank does not run on every keystroke. The query itself updates immediately, so only the re-render waits.
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

    // Scrolling changes which rows are on screen, which is one of the two signals that re-tiers the weekly-data queue. Throttled with rAF, and a no-op when no bulk fetch is running.
    const leaderboardScrollEl = document.getElementById('player-leaderboard-container');
    if (leaderboardScrollEl) {
        let scrollTierQueued = false;
        leaderboardScrollEl.addEventListener('scroll', () => {
            if (scrollTierQueued) return;
            scrollTierQueued = true;
            requestAnimationFrame(() => {
                scrollTierQueued = false;
                reprioritizeWeeklyQueue();
            });
        });
    }
    document.getElementById('player-availability-filter').addEventListener('change', (e) => {
        AppState.playerAvailabilityFilter = e.target.value;
        renderPlayerLeaderboard();
    });

    // Export and Recap live inside the results area, so they only appear once data has loaded. Both modals re-read current state on every open.
    document.getElementById('export-btn').addEventListener('click', openExportModal);
    document.getElementById('recap-btn').addEventListener('click', openRecapModal);

    // The icon legend popover explains the crown, the rank medals and the trend arrows. A click outside or Escape closes it, while clicks inside are ignored so the list stays open while it is read.
    const legendBtn = document.getElementById('legend-btn');
    const legendPopover = document.getElementById('legend-popover');
    if (legendBtn && legendPopover) {
        const setLegendOpen = (open) => {
            legendPopover.hidden = !open;
            legendBtn.setAttribute('aria-expanded', String(open));
        };
        legendBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            setLegendOpen(legendPopover.hidden);
        });
        document.addEventListener('click', (e) => {
            if (!legendPopover.hidden && !legendPopover.contains(e.target)) setLegendOpen(false);
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !legendPopover.hidden) setLegendOpen(false);
        });
    }

    // 5. Debug panel bindings
    document.getElementById('debug-download-btn').addEventListener('click', downloadDebugData);
    // The panel skips serializing its payload while collapsed, so catch it up whenever it is opened. Opening is also the trigger for the drill-down's on-demand diagnostic capture.
    const debugPanel = document.getElementById('debug-panel');
    debugPanel.addEventListener('toggle', () => {
        refreshDebugPanel();
        if (debugPanel.open) ensurePlayerDetailDiagnostic();
    });

    // 6. Tab navigation bindings
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
            // Re-render on return: anything measured while this tab was display:none reads zero heights, which silently dropped the inline pies until some later render happened to run while visible.
            if (AppState.apiData) {
                renderLeftColumn();
                renderRightColumn();
                renderHeatmapBand();
            }
        } else {
            // A drill-down left open from a previous visit stays open, so match the panel to whichever is actually showing rather than assuming the leaderboard.
            setActiveDebugKind(AppState.selectedPlayerId !== null ? 'player-detail' : 'player-pool');
            loadPlayerTabIfNeeded();
        }
    }

    tabBtnTeam.addEventListener('click', () => switchTab('team'));
    tabBtnPlayer.addEventListener('click', () => switchTab('player'));
});
