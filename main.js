import { checkAuth, setupAuthWatchers, loadStoredSettings, fetchEspnData, setPostFetchHook, renderMyLeaguesOptions } from './api.js';
import { renderLeftColumn, renderRightColumn, renderHeatmapBand, setupCardPopout, isCardPopoutOpen, closeCardPopout } from './graphs.js';
import { AppState } from './state.js';
import { loadPlayerTabIfNeeded, renderPlayerLeaderboard, openPlayerDetail, closePlayerDetail, ensurePlayerDetailDiagnostic, reprioritizeWeeklyQueue, setWeeklyProgressHook, retryPlayerPoolAfterLogin } from './players.js';
import { downloadDebugData, setActiveDebugKind, refreshDebugPanel, setupHintTooltips, pinDebugKind } from './utils.js';
import { openExportModal } from './export.js';
import { openRecapModal } from './recap.js';
import { syncRotoTimeframePills } from './controls.js';
import { renderMyTeamTab, invalidateMyTeamLayout } from './myteam.js';

// Betting lines are OFF until the user turns them on, and while they are off the scoreboard is never even requested (see myteam.js) - so an install that never opts in makes no betting-related call at all. That is the honest default for a fantasy tool and it is also the posture the store question in docs/PUBLISHING.md turns on. localStorage rather than browser.storage, matching the theme beside it. Both are display preferences that must be readable synchronously at render time.
function setupOddsPreference() {
    const box = document.getElementById('pref-odds');
    if (!box) return;
    box.checked = oddsEnabled();
    box.addEventListener('change', () => {
        try { localStorage.setItem('efv-odds', box.checked ? 'on' : 'off'); } catch { /* storage off */ }
        AppState.showBettingOdds = box.checked;
        renderMyTeamTab();
    });
    AppState.showBettingOdds = box.checked;
}

function oddsEnabled() {
    try { return localStorage.getItem('efv-odds') === 'on'; } catch { return false; }
}

// Theme is a select in the settings panel rather than a cycling button in the header. The chosen mode is stored in localStorage and re-applied synchronously by theme-init.js before the stylesheet paints, so there is no flash; "auto" removes data-theme entirely and hands control back to the prefers-color-scheme query in dashboard.css.
function setupThemeToggle() {
    const select = document.getElementById('pref-theme');
    if (!select) return;
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
    };
    select.value = read();
    apply(select.value);
    select.addEventListener('change', () => apply(select.value));
}


// Season Trends pop-out. Expands the trends chart into an in-page overlay filling the tab area, with the Data Filters content (Trend Lines + Teams legend) docked in a side rail so every control still live-updates the enlarged chart. The timeframe pills live in the always-visible tab bar above the overlay, so they stay usable without being moved. We MOVE the real chart and filter nodes (not clones) so their existing event wiring keeps working, then move them back on restore. The chart is re-rendered at the new container size via renderRightColumn (its SVG sizes to the container - see renderTrendGraph), never CSS-scaled up from the small render. Every pop-out overlay built by createPopoutController. Both overlays dock the SAME Teams legend node, so only one may be open at a time - opening one closes the others before it claims those nodes. Keeping the list here means neither controller has to know the other exists.
const popoutControllers = [];

// Shared machinery for the Season Trends (B2/) and Category Heatmap pop-outs. Both MOVE the real content and filter nodes into the overlay (never clones) so their existing event wiring keeps working, then move them back on restore - which is also why the restore order below matters: the filter groups live in the Data Filters body as [Trend Lines, Teams], and appending them in that order puts them back exactly where the static markup had them.
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

    // Season Trends: the chart plus BOTH Data Filters groups, so Trend Lines and the Teams legend both live-update the enlarged chart. The timeframe pills stay in the always-visible tab bar above the overlay, so they never need moving.
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
        // The box renames itself to "Matchup Scoreboard" at a single matchup (updateTrendsBoxChrome).
        titleFrom: () => document.getElementById('trends-box-title').textContent,
        // Re-render into the now-larger container. renderTrendGraph reads no fixed pixel size (its SVG is width/height 100% over a viewBox), so this draws crisp at the overlay size.
        onOpen: () => renderRightColumn(),
        // Fresh measurements for the restored small layout - both columns re-fit (the trends chart back to its column, and the rankings box's rAF-measured pies/compact bars), the same pair the Data Filters toggle re-runs when it changes the columns' height budget.
        onClose: () => { renderLeftColumn(); renderRightColumn(); }
    });

    // Category Heatmap: the band plus only the Teams legend - Trend Lines drives the trends chart, which isn't in this overlay. Re-rendering on open drops the 10-row cap (the overlay has the height for a whole league and scrolls internally past that); re-rendering on close restores it, and the two columns re-fit around the band's height changing back.
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

    // One Escape handler for every overlay. It yields to the legend popover's own Esc-close: if that's open it takes this press and the overlays stay put, so one press never does two things. Only one overlay can be open at a time, so closing them all closes exactly one.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!popoutControllers.some(c => c.isOpen()) && !isCardPopoutOpen()) return;
        const legendPopover = document.getElementById('legend-popover');
        if (legendPopover && !legendPopover.hidden) return;
        // Closes the TOPMOST surface only, so one press never does two things (the same rule that makes this handler yield to the legend popover above). The per-card pop-out can sit over the scoreboard's own pop-out - drilling from the week into one matchup - so when it's up it takes the press and the overlay underneath stays. It isn't a createPopoutController: it renders fresh content rather than MOVING nodes, so it has no home to restore.
        if (isCardPopoutOpen()) {
            closeCardPopout();
            return;
        }
        popoutControllers.forEach(c => c.close());
    });
}

document.addEventListener('DOMContentLoaded', async () => {

    // Redirect to a full tab if opened as a small popup (width < 800px) - but ONLY on the first, untagged load. The tab this opens carries ?tab=1, and a tagged load skips this check entirely regardless of its own width. That tag is what stops an infinite loop on Firefox for Android is why. There, EVERY surface (the popup AND the tab it opens) renders at the phone's screen width, always under 800px - without the tag, the tab this code just opened would trip the same width check on its own load and open ANOTHER tab, forever. A width heuristic alone can't distinguish "the cramped popup that should redirect" from "the real tab that redirect landed in" on a device where both are narrow; a URL param can, since it only marks "this load IS the redirect target," not "this screen is wide." We strip ?tab=1 from the URL after this check (below) so the address bar reads clean, so the guard also honors a per-tab sessionStorage marker. A manual reload of the stripped tab is untagged but still marked, so it won't spawn a duplicate. Page window.sessionStorage (per-tab, survives reload, dies with the tab) is exactly the right scope - NOT browser.storage.session, which is extension-global and would wrongly suppress the redirect in every future popup too.
    const params = new URLSearchParams(location.search);
    let alreadyTab = params.has('tab');
    try { alreadyTab = alreadyTab || sessionStorage.getItem('lwTab') === '1'; } catch { /* storage disabled - fall back to the URL tag alone */ }
    // <=, not <, and the difference is the whole of. A browser-action popup is CLAMPED to 800px wide, so "narrower than 800" was never a test for being in one. A document whose preferred width reaches 800 opens at exactly 800, the strict comparison is false, and the popup stops recognising itself. It then renders the whole dashboard in a viewport that has no height to give - `html, body { height: 100vh }` has nothing to resolve against when the popup is sizing to content - and settles at 800x10. That is the sliver, measured from the popup's own readout, and it took two wrong theories to get there. A popup can never be wider than the clamp, so this now means "always redirect a popup", which is what the check was always trying to say. The width ceiling asserted in tests/popup-harness.html stays as the second guard rather than the only one.
    if (!alreadyTab && window.innerWidth <= 800) {
        browser.tabs.create({ url: browser.runtime.getURL("dashboard.html") + "?tab=1" });
        window.close();
        return;
    }
    // On the tagged load, mark this tab and drop the query so the URL bar reads clean. Only the 'tab' param goes; any others (dev-preview's ?payload= etc.) are preserved so a reload keeps them - in the real extension ?tab=1 is the only param, so this collapses to a bare pathname.
    if (params.has('tab')) {
        try { sessionStorage.setItem('lwTab', '1'); } catch { /* storage disabled - the load still works, only the reload guard is lost */ }
        params.delete('tab');
        const qs = params.toString();
        history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
    }

    // Theme toggle is independent of league data - wire it first so it works immediately.
    setupOddsPreference();
    setupThemeToggle();

    // Season Trends and Category Heatmap pop-out overlays - wired once; their buttons live in the tab view that only appears after data loads, but the elements exist in the static markup from the start.
    setupPopouts();
    // The per-card pop-out overlay's close button. Its open triggers live on the cards, which are rebuilt on every scoreboard render, so those are wired there instead.
    setupCardPopout();

    // The Roto Race fills in progressively as the bulk weekly fetch's chunks land, the same behavior the leaderboard arrows have. This hook fires on each debounced chunk repaint; re-rendering the trends box picks up the newly cached weeks. Gated to roto so it costs nothing for matchup leagues, whose trends box doesn't read the weekly cache. Wired here (rather than players.js calling renderRightColumn) to keep the players -> graphs import one-directional. Also promote the timeframe pill row the first time the started-day harvest lands: roto windows are only honest on started-day data, so the pills stay hidden until then and appear exactly once (syncRotoTimeframePills self-guards against the repeated chunk fires).
    setWeeklyProgressHook(() => {
        if (!AppState.isRotoLeague) return;
        renderRightColumn();
        syncRotoTimeframePills();
        // The Rankings box has to re-fit too. Two things change under it as the harvest lands: its category races only become drawable once rotoCategorySeries has data, and the pill row appearing changes the height every box is measured against. Without this the category layout keeps whatever it computed at the smaller early size - measured on the 2025 roto fixture: five teams split into two columns because the box was short when it first rendered, where a fresh render at the settled height gives one clean column.
        renderLeftColumn();
    });

    // Refresh the Player Metrics view after any successful league fetch. This lives on the shared hook rather than in the Fetch Data handler below because the My Leagues picker auto-fetches without going near that handler, which left its leaderboard showing the PREVIOUS league's players. Registered before checkAuth() since that builds the picker, and the picker can start a fetch the moment it exists.
    setPostFetchHook(async ({ reopenPlayerId }) => {
        // processCoreData() already invalidated the cached player pool (new year/league/sport), but if Player Metrics is the tab currently on screen, nothing else re-triggers a reload until the tab is clicked again - refresh it immediately instead of leaving the previous fetch's stale leaderboard showing.
        const playerView = document.getElementById('view-player');
        if (!playerView || playerView.style.display === 'none') return;
        await loadPlayerTabIfNeeded();
        // Reopen the prior drill-down ONLY if that player is in the NEW league's pool. A year change (same league) keeps the id, so it reopens with fresh data - the intended case. A sport or league change won't have the id, so close the drill-down back to the (freshly rendered) leaderboard instead of leaving the previous league's player painted over the new one. Checked here, after the pool load above, and guarded on pool membership rather than sport strings so a same-sport league switch where the player isn't pooled also lands cleanly. reopenPlayerId was captured before processCoreData wiped it (see fetchEspnData).
        if (reopenPlayerId !== null) {
            if (AppState.playerData.some(p => p.id === reopenPlayerId)) openPlayerDetail(reopenPlayerId, true);
            else closePlayerDetail();
        }
    });

    // One delegated listener for every ⓘ on the page, including the ones panels render later. Wired once, before anything renders.
    setupHintTooltips();

    // Logging in with the dashboard already open should heal it where the user is standing, on any tab, without a manual refresh. made the cookies arriving detectable; this is what the app does about it. Two failures are worth retrying and they are ordered, since the league payload is what the pool is fetched against: 1. The league itself was refused, which is a private league read with no cookies. Re-fetch it, and the post-fetch hook above rebuilds every tab from there. 2. The league loaded (restrictionType NONE) but the pool was refused. Re-fetch just that. Anything else means nothing was broken, which is the ordinary logged-in startup, so it stops.
    document.addEventListener('leaguewise:auth-restored', async () => {
        if (AppState.leagueDataError) {
            AppState.leagueDataError = null;
            await fetchEspnData();
            return;
        }
        await retryPlayerPoolAfterLogin();
    });

    // 1. Initial Checks & Load Data Install first, log in second is the normal first run, so the dashboard watches for the cookies arriving instead of waiting for a refresh nobody thinks to do. Wired BEFORE the first check, so a login that lands mid-startup is still noticed.
    setupAuthWatchers();
    await checkAuth();
    await loadStoredSettings();

    // 2. Main API Binding
    document.getElementById('fetch-btn').addEventListener('click', () => fetchEspnData());

    // Re-filter the My Leagues picker to whichever sport is now selected. Discovery keeps the full cross-sport list in memory; this just re-renders the visible options, so hockey leagues never show while Baseball is selected and a switch that hides the current pick resets it to the placeholder without fetching. A no-op before discovery runs or when nothing was found.
    document.getElementById('sport').addEventListener('change', renderMyLeaguesOptions);

    // 3. Viewport Trigger Bindings Gear toggles the collapsed league-settings fields back open (see collapseSettingsBar) - class-based so the open/close eases via.settings-bar's transition.
    document.getElementById('settings-toggle-btn').addEventListener('click', () => {
        const collapsed = document.getElementById('settings-bar').classList.toggle('collapsed');
        // The handle rides the rail's outer edge, so it moves with it ( redesign).
        document.body.classList.toggle('settings-closed', collapsed);
    });
    // Deliberately no re-render here, and it stays that way. The bar is 64px of the page's height, so every view's budget changes when it moves, and the first attempt at this re-fitted My Team once the transition finished. That was worse than doing nothing. The roster overflowed for the half-second the bar was animating, then the density ladder snapped the type to a new size. Team Metrics and Player Metrics run no JS on this toggle at all, which is why they look right. Their content shrinks in CSS and the parts that cannot shrink scroll inside themselves. My Team can do exactly the same..mt-roster is flex:1 1 auto with min-height:0 and overflow-y:auto, so it takes whatever height is left and scrolls internally, no different from the leaderboard's table. The density chosen when the tab was entered stays, which is what makes the size stable instead of jumping on a control that is only meant to show a form.

    document.getElementById('toggle-cat').addEventListener('change', renderRightColumn);
    document.getElementById('toggle-match').addEventListener('change', renderRightColumn);

    // The Rankings box's header tabs switch it between Team Rankings (standings bars, each section flippable to its own pie) and Category Rankings. Only the Rankings box re-renders - Season Trends and the heatmap are unaffected by which view the box is showing.
    const setRankingsBoxView = (view) => {
        if (AppState.rankingsBoxView === view) return;
        AppState.rankingsBoxView = view;
        renderLeftColumn();
    };
    document.getElementById('rankings-tab-standings').addEventListener('click', () => setRankingsBoxView('standings'));
    document.getElementById('rankings-tab-category').addEventListener('click', () => setRankingsBoxView('category'));

    // Collapsible Filters box (closed by default), now a full-width bar at the bottom of the tab - toggling it changes how much vertical space the three top columns get, so re-fit all of them (standings + trends + rankings). The heatmap band is content-sized and unaffected.
    document.getElementById('filters-toggle').addEventListener('click', () => {
        const panel = document.getElementById('control-panel');
        const collapsed = panel.classList.toggle('collapsed');
        document.getElementById('filters-toggle').setAttribute('aria-expanded', String(!collapsed));
        renderLeftColumn();
        renderRightColumn();
    });

    // Both pop-outs' docked filter boxes collapse the same way ( for the heatmap, for the trends chart). Collapsing hands the height to the chart underneath, so each re-renders its own content into the taller slot - the same reason the main Data Filters toggle re-renders the columns it just resized.
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

    // 4. Player Leaderboard Bindings Re-rendering the whole leaderboard (re-filtering/re-ranking the pool) on every single keystroke is wasted work while the user is still mid-word - debounce so it only fires once typing actually pauses. AppState.playerSearchQuery itself still updates immediately, so the input box's own displayed value is never delayed, only the re-render is.
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

    // Scrolling the leaderboard changes which rows are on screen, which is one of the two signals that re-tiers the weekly-data queue (the other is a re-sort/filter, handled inside renderPlayerLeaderboard). Throttled with rAF. A scroll fires continuously, and re-tiering once per frame at most is plenty for a queue whose next request is at least a chunk away. A no-op when no bulk fetch is running.
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

    // Export/Recap live in the tab bar (inside #results, so they only appear once data has loaded) - both modals re-read current state on every open, so no other wiring is needed.
    document.getElementById('export-btn').addEventListener('click', openExportModal);
    document.getElementById('recap-btn').addEventListener('click', openRecapModal);

    // Icon legend popover: a quiet share-toolbar affordance that opens a compact list explaining the crown, Rank medals, and trend arrows. Toggling flips [hidden]; any click outside the menu, or Escape, closes it so it never lingers over the data. The button's own stopPropagation keeps its toggle from being immediately re-closed by the same document handler, and clicks INSIDE the popover are ignored so the list stays open while it's read.
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

    // 5. Debug Panel Bindings
    document.getElementById('debug-download-btn').addEventListener('click', downloadDebugData);
    // Delegated, because the buttons are rebuilt every time a response lands or the shown kind changes, so anything bound to an individual button would be thrown away with it.
    document.getElementById('debug-kinds').addEventListener('click', (e) => {
        const btn = e.target.closest('.debug-kind');
        if (btn && !btn.disabled) pinDebugKind(btn.dataset.kind);
    });
    // The panel's own <details> lazily skips serializing its payload while collapsed (see setDebugContext/renderActiveDebugContext in utils.js) - catch it up whenever it's opened, in case its active context changed in the background while it sat collapsed. Opening is also the trigger for the drill-down's on-demand diagnostic capture (see ensurePlayerDetailDiagnostic). A no-op unless a player is open with nothing captured yet.
    const debugPanel = document.getElementById('debug-panel');
    debugPanel.addEventListener('toggle', () => {
        refreshDebugPanel();
        if (debugPanel.open) ensurePlayerDetailDiagnostic();
    });

    // 6. Tab Navigation Bindings
    const tabBtnTeam = document.getElementById('tab-btn-team');
    const tabBtnPlayer = document.getElementById('tab-btn-player');
    const viewTeam = document.getElementById('view-team');
    const viewPlayer = document.getElementById('view-player');

    const tabBtnMyTeam = document.getElementById('tab-btn-myteam');
    const viewMyTeam = document.getElementById('view-myteam');

    function switchTab(name) {
        const isTeam = name === 'team';
        const isMine = name === 'myteam';
        tabBtnTeam.classList.toggle('active', isTeam);
        tabBtnPlayer.classList.toggle('active', name === 'player');
        tabBtnMyTeam.classList.toggle('active', isMine);
        viewTeam.style.display = isTeam ? 'flex' : 'none';
        viewPlayer.style.display = name === 'player' ? 'flex' : 'none';
        viewMyTeam.style.display = isMine ? 'flex' : 'none';
        // My Team measures its own bands, so it re-renders on every entry for the same reason the Team tab does. Anything measured while the view was display:none reads zero.
        if (isMine) {
            setActiveDebugKind(AppState.selectedPlayerId !== null ? 'player-detail' : 'player-pool');
            // Re-fit from scratch on entry. What was measured last time was measured for whatever league, roster and window size were on screen then, and any of the three can have changed while this tab was away.
            invalidateMyTeamLayout();
            renderMyTeamTab();
            return;
        }
        if (isTeam) {
            setActiveDebugKind('team');
            // Re-render on return. The columns' layout-measuring steps (inline-pie placement, compact-row fallback - see renderLeftColumn/renderCategoryGraph in graphs.js) read zero heights for anything measured while this tab was display:none, silently dropping the inline pies until some other re-render happened to run while visible (confirmed: pies vanishing after a visit to the Player tab, coming back only after toggling the timeframe). Re-rendering now measures real geometry.
            if (AppState.apiData) {
                renderLeftColumn();
                renderRightColumn();
                renderHeatmapBand();
            }
        } else {
            // A drill-down left open from a previous visit stays open (loadPlayerTabIfNeeded only touches the leaderboard container) - match the panel to whichever is actually showing rather than always assuming the leaderboard.
            setActiveDebugKind(AppState.selectedPlayerId !== null ? 'player-detail' : 'player-pool');
            loadPlayerTabIfNeeded();
        }
    }

    tabBtnTeam.addEventListener('click', () => switchTab('team'));
    tabBtnPlayer.addEventListener('click', () => switchTab('player'));
    tabBtnMyTeam.addEventListener('click', () => switchTab('myteam'));
});
