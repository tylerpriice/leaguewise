/**
 * Entry point of the dashboard page. Once the DOM is ready it wires the settings controls, the
 * tab machinery, the pop-out overlays, the timeframe and legend popovers and the diagnostic
 * panel to the modules that render each view.
 *
 * Importing this module has side effects. It registers a DOMContentLoaded handler and exports
 * nothing.
 * @module main
 */
import { checkAuth, setupAuthWatchers, loadStoredSettings, fetchEspnData, setPostFetchHook, renderMyLeaguesOptions, discoveredLeagueByKey, loadArchiveFile, isArchiveLoaded, archiveInfo, captureStepsFor, seasonCaptureSteps } from '../data/api.js';
import { captureAll, captureEstimate } from '../data/capture-all.js';
import { renderLeftColumn, renderRightColumn, renderHeatmapBand, renderTeamMetricsTab, setupCardPopout, isCardPopoutOpen, closeCardPopout } from './graphs.js';
import { AppState } from '../data/state.js';
import { loadPlayerTabIfNeeded, renderPlayerLeaderboard, openPlayerDetail, closePlayerDetail, ensurePlayerDetailDiagnostic, reprioritizeWeeklyQueue, setWeeklyProgressHook, matchupRaceStatus, retryPlayerPoolAfterLogin, refreshOpenPlayerDetail, playerCaptureSteps } from './players.js';
import { downloadDebugData, downloadAllDebugData, setActiveDebugKind, refreshDebugPanel, setupHintTooltips, setupLongPressDisclosures, pinDebugKind, registerLeagueView, showLeagueView, renderActiveLeagueView, wirePushPanel, setDiagnosticPanelEnabled, debugContextFor, seasonsSeenFor, yearOptionsWith } from './utils.js';
import { seasonState, isPreseason, SEASON_STATE } from '../data/season-state.js';
import { openExportModal } from './export.js';
import { openRecapModal } from './recap.js';
import { syncRotoTimeframePills, setTimeframeVisible, closeTimeframePopover, refitTeamFilters } from './controls.js';
import { renderMyTeamTab, invalidateMyTeamLayout } from './myteam.js';
import { renderHistoryTab } from './history-view.js';
import { renderDraftTab, resetDraftView } from './draft-view.js';

// Betting lines are off until the reader turns them on, and while they are off the scoreboard is never requested, so an install that never opts in makes no betting-related call. The preference lives in localStorage like the theme, since both must be readable synchronously at render time.
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

// The run order is the league payload, the season list, the draft, the pro schedule, today's roster, the pool, the weekly lines, the transaction log, the daily lineups, and the scoreboard only if betting lines are on. The long harvests come last, so a run that is refused or cancelled part-way still holds everything above it.
const CAPTURE_ORDER = ['team', 'league-history', 'draft-detail', 'pro-schedule', 'roster',
    'player-pool', 'player-weekly', 'transactions', 'roster-days', 'odds'];
function orderedCaptureSteps() {
    const steps = [...captureStepsFor({ oddsOn: oddsEnabled() }), ...playerCaptureSteps(AppState.loadedSport)];
    const rank = (kind) => { const i = CAPTURE_ORDER.indexOf(kind); return i < 0 ? CAPTURE_ORDER.length : i; };
    return steps.sort((a, b) => rank(a.kind) - rank(b.kind));
}

function oddsEnabled() {
    try { return localStorage.getItem('efv-odds') === 'on'; } catch { return false; }
}

// The diagnostic panel is a maintainer's tool, so it is off unless asked for, and off means absent from the page, since even the collapsed bar cost a row the Team Metrics tab cannot spare. It is read synchronously like the odds preference because visibility is decided during the first render. Turning it on mid-session shows the true tally for the whole session, because the count runs at the fetch site from page load.
function setupDiagnosticPreference() {
    const box = document.getElementById('pref-diagnostic');
    if (!box) return;
    box.checked = diagnosticEnabled();
    box.addEventListener('change', () => {
        try { localStorage.setItem('efv-diagnostic', box.checked ? 'on' : 'off'); } catch { /* storage off */ }
        setDiagnosticPanelEnabled(box.checked);
    });
    setDiagnosticPanelEnabled(box.checked);
}

function diagnosticEnabled() {
    try { return localStorage.getItem('efv-diagnostic') === 'on'; } catch { return false; }
}

// Theme and style are selects in the settings panel. Each choice is stored in localStorage and applied by theme-init.js before the stylesheet paints, so there is no flash. "Auto" removes data-theme and hands control back to the prefers-color-scheme query. The code re-applies on load anyway, so a control that disagrees with the attribute loses.
function setupStylePreference() {
    const select = document.getElementById('pref-style');
    if (!select) return;
    const read = () => {
        try { return localStorage.getItem('efv-style') === 'modern' ? 'modern' : 'boxscore'; }
        catch { return 'boxscore'; }
    };
    const apply = (style) => {
        document.documentElement.setAttribute('data-style', style);
        try { localStorage.setItem('efv-style', style); }
        catch { /* private mode / storage disabled - the style still applies for this session */ }
    };
    select.value = read();
    apply(select.value);
    select.addEventListener('change', () => apply(select.value));
}

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


// Season Trends pop-out. It expands the trends chart into an overlay over the tab area with the Data Filters docked in a side rail. The real chart and filter nodes are moved, not cloned, so their event wiring keeps working, and the chart is re-rendered at the new container size. Only one overlay may be open at a time because both dock the same Teams legend node, so opening one closes the others first.
const popoutControllers = [];

// Shared machinery for the Season Trends and Category Heatmap pop-outs. Both move the real nodes into the overlay and back on restore, so the restore order matters. The filter groups go back as Trend Lines then Teams, which is where the static markup had them.
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
            refitTeamFilters();
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
            refitTeamFilters();
            onOpen();
        }
    };

    openBtn.addEventListener('click', controller.open);
    closeBtn.addEventListener('click', controller.close);
    popoutControllers.push(controller);
    return controller;
}

// The settings run in steps: Sport, League, Year, Fetch. Year stays disabled until a league is chosen or an id is typed, and Fetch until a year is set. A saved league fills the fields and fetches nothing. #league-id stays a text input because every reader of the settings uses it, so script-set values reach the steps through a property shim.
function wireSettingsOrder() {
    const sport = document.getElementById('sport');
    const league = document.getElementById('league-id');
    const year = document.getElementById('year');
    const fetchBtn = document.getElementById('fetch-btn');
    const picker = document.getElementById('my-leagues');
    if (!sport || !league || !year || !fetchBtn) return;

    const sync = () => {
        const hasLeague = league.value.trim() !== '';
        year.disabled = !hasLeague;
        fetchBtn.disabled = !hasLeague || !year.value;
    };

    // Every script write to #league-id goes through the element's own `value` accessor, so it is observed here.
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    Object.defineProperty(league, 'value', {
        configurable: true,
        get() { return proto.get.call(this); },
        set(v) { proto.set.call(this, v); sync(); }
    });
    league.addEventListener('input', sync);
    year.addEventListener('change', sync);
    sport.addEventListener('change', sync);

    if (picker) {
        // A choice in the saved-leagues picker: api.js has filled sport, league id and year (and fetched nothing); the Year list is rebuilt from this league's own seasons. Deferred a tick so it runs after api.js's own handler.
        picker.addEventListener('change', () => setTimeout(() => {
            const found = picker.value ? discoveredLeagueByKey(picker.value) : null;
            if (found) {
                const seen = seasonsSeenFor(found.sport, found.leagueId);
                const years = yearOptionsWith(seen, found.seasonId);
                year.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
                if (found.seasonId) year.value = String(found.seasonId);
            }
            sync();
        }, 0));
    }
    sync();
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
        // Fresh measurements for the restored small layout. Both columns re-fit, the trends chart back to its column and the rankings box's measured pies and compact bars, the same pair the Data Filters toggle re-runs.
        onClose: () => { renderLeftColumn(); renderRightColumn(); }
    });

    // The Category Heatmap overlay holds the band and only the Teams legend, since Trend Lines drives a chart that is not in it. Opening drops the 10-row cap because the overlay has the height, and closing restores it and re-fits the two columns.
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

    // One Escape handler serves every overlay. It yields to the legend popover's own Escape handling so one press never does two things, and only one overlay can be open at a time.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!popoutControllers.some(c => c.isOpen()) && !isCardPopoutOpen()) return;
        const legendPopover = document.getElementById('legend-popover');
        if (legendPopover && !legendPopover.hidden) return;
        // Closes the topmost surface only. The per-card pop-out can sit over the scoreboard's pop-out, so when it is up it takes the press. It is not a pop-out controller because it renders fresh content instead of moving nodes, so it has no home to restore.
        if (isCardPopoutOpen()) {
            closeCardPopout();
            return;
        }
        popoutControllers.forEach(c => c.close());
    });
}

/**
 * Wires the phone masthead: a round three-dot button in the brand row that opens the utility rail as a
 * small sheet (the rail's own buttons, so their handlers are untouched), and the tab strip keeping its
 * active pill in view. Both are inert above 700px, where the stylesheet hides the button and the rail
 * stays where it was.
 *
 * @returns {void}
 */
function wirePhoneMasthead() {
    const host = document.querySelector('.brand-header-right');
    const rail = document.querySelector('.utility-rail');
    if (host && rail && !document.getElementById('mm-more')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'mm-more';
        btn.className = 'mm-more';
        btn.setAttribute('aria-label', 'More');
        btn.setAttribute('aria-haspopup', 'true');
        btn.setAttribute('aria-expanded', 'false');
        btn.innerHTML = '<span class="mm-dot"></span><span class="mm-dot"></span><span class="mm-dot"></span>';
        host.appendChild(btn);
        const close = () => { rail.classList.remove('mm-open'); btn.setAttribute('aria-expanded', 'false'); };
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = rail.classList.toggle('mm-open');
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        // An action in the sheet closes it, and so does a tap anywhere outside it; the legend's own button keeps it open.
        rail.addEventListener('click', (e) => {
            const hit = e.target.closest('button');
            if (hit && hit.id !== 'legend-btn') setTimeout(close, 0);
        });
        document.addEventListener('click', (e) => { if (!e.target.closest('.utility-rail, #mm-more')) close(); });
    }
    wirePhoneBottomBar();
    wirePhoneDismiss();
    wirePhoneFiltersChip();
    wirePhoneStrips();
    const strip = document.querySelector('.tabs-container');
    if (strip) {
        const settle = () => {
            const active = strip.querySelector('.tab-button.active');
            if (active && strip.scrollWidth > strip.clientWidth) strip.scrollTo({ left: Math.max(0, active.offsetLeft - 12), behavior: 'auto' });
        };
        strip.addEventListener('click', () => setTimeout(settle, 0));
        settle();
        // The strip is laid out once a league has loaded, so the first settle often has nothing to measure.
        new MutationObserver(() => settle()).observe(strip, { attributes: true, subtree: true, attributeFilter: ['class'] });
    }
}

// One way out for every phone sheet: a tap outside it (pointer events, so a touch sequence counts the same as a mouse), the Escape key, and its own close control. Each surface says when it is open, what counts as inside it and how to close it.
function wirePhoneDismiss() {
    if (document.body.dataset.phoneDismiss) return;
    document.body.dataset.phoneDismiss = '1';
    const phone = window.matchMedia('(max-width: 700px)');
    const q = (s) => document.querySelector(s);
    const vis = (e) => !!e && e.getBoundingClientRect().width > 0;
    const closeBtn = (head) => { const b = head && head.querySelector('.mt-drawer-close, .mt-strip-open'); if (b) b.click(); };
    // Topmost first: what is stacked over what decides which one a tap or an Escape takes.
    const surfaces = [
        { name: 'compare drawer', open: () => vis(q('.mt-compare-drawer:not([hidden])')), inside: '.mt-compare-drawer', close: () => closeBtn(q('.mt-compare-drawer .mt-drawer-head')) },
        { name: 'coverage drawer', open: () => vis(q('.mt-coverage-drawer:not([hidden])')), inside: '.mt-coverage-drawer', close: () => closeBtn(q('.mt-coverage-drawer .mt-drawer-head')) },
        { name: 'filter sheet', open: () => !!q('#view-player[class*="pm-open-"]'), inside: '#player-toolbar, #pm-bar',
            close: () => { const b = q('#pm-bar [data-sheet][aria-expanded="true"]'); if (b) b.click(); } },
        { name: 'timeframe sheet', open: () => { const t = q('#timeframe-toggle'); return !!t && !t.hidden; }, inside: '.timeframe-menu', close: () => closeTimeframePopover() },
        { name: 'settings', open: () => { const b = q('#settings-bar'); return !!b && !b.classList.contains('collapsed'); }, inside: '#settings-bar, #settings-toggle-btn',
            close: () => { const b = q('#settings-bar'); if (b) b.classList.add('collapsed'); document.body.classList.add('settings-closed'); } },
        { name: 'more sheet', open: () => { const r = q('.utility-rail'); return !!r && r.classList.contains('mm-open'); }, inside: '.utility-rail, #mm-more',
            close: () => { const r = q('.utility-rail'); if (r) r.classList.remove('mm-open'); const m = q('#mm-more'); if (m) m.setAttribute('aria-expanded', 'false'); } },
        { name: 'matchup menu', open: () => { const m = q('.scoreboard-hover'); return !!m && m.classList.contains('sb-open'); }, inside: '.scoreboard-hover',
            close: () => { const m = q('.scoreboard-hover'); if (m) m.classList.remove('sb-open'); } },
        // A card that opens over a list has its own back pill; Escape takes it, a tap beside it does not.
        { name: 'league history card', escapeOnly: true, open: () => vis(q('.lh-rivalry.lh-open .lh-riv-back')), inside: '.lh-rivalry',
            close: () => { const b = q('.lh-rivalry.lh-open .lh-riv-back'); if (b) b.click(); } }
    ];
    const topmost = () => surfaces.find(sf => sf.open());
    const tappable = () => surfaces.find(sf => !sf.escapeOnly && sf.open());
    let swallow = 0;
    // A TAP outside closes, a swipe that begins outside does not: the pointer must come up within a few px and a short time of where it went down (a scroll takes the pointer away with a pointercancel, so it never comes up at all).
    let down = null;
    document.addEventListener('pointerdown', (e) => {
        down = null;
        if (!phone.matches) return;
        const sf = tappable();
        if (!sf || e.target.closest(sf.inside)) return;
        down = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId, bar: !!e.target.closest('#px-bottom') };
    }, true);
    document.addEventListener('pointercancel', () => { down = null; }, true);
    document.addEventListener('pointerup', (e) => {
        const d = down;
        down = null;
        if (!d || d.id !== e.pointerId || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10 || Date.now() - d.t > 600) return;
        // The tab bar's own taps close everything open and then do their job.
        if (d.bar) { for (let i = 0; i < 8 && tappable(); i++) tappable().close(); return; }
        const sf = tappable();
        if (!sf) return;
        sf.close();
        swallow = Date.now() + 700;
    }, true);
    // The matchup menu was a hover alone: at phone width a tap opens and closes it.
    document.addEventListener('click', (e) => {
        if (!phone.matches) return;
        const m = e.target.closest('.scoreboard-hover');
        if (m) m.classList.toggle('sb-open');
    });
    document.addEventListener('click', (e) => {
        if (!swallow) return;
        const live = Date.now() < swallow;
        swallow = 0;
        if (live) { e.stopPropagation(); e.preventDefault(); }
    }, true);
    // Capture phase: a press that closes a sheet is this press's whole job, so it never reaches the surface's own Escape handler too.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !phone.matches) return;
        const sf = topmost();
        if (!sf) return;
        sf.close();
        e.stopPropagation();
    }, true);
    // With nothing else open, Escape leaves the drill-down the way its back button does.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !phone.matches || topmost() || isCardPopoutOpen()) return;
        const legend = q('#legend-popover');
        if (legend && !legend.hidden) return;
        const back = q('#player-back-btn');
        if (vis(back)) back.click();
    });
    // The settings bar's own close: a round pill in its head, shown at phone width only (the stylesheet hides it above).
    const head = q('.settings-rail-head');
    if (head && !head.querySelector('.settings-close')) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'settings-close';
        b.setAttribute('aria-label', 'Close settings');
        b.innerHTML = '&#10005;';
        b.addEventListener('click', () => surfaces.find(sf => sf.name === 'settings').close());
        head.appendChild(b);
    }
}

// Every sideways strip of pills at phone width shows a whole number of items, with a round chevron pill saying there is more.
const PHONE_STRIPS = '#view-team .rankings-tabs, .lh-focus-tabs, .lh-year-strip, .lh-rail-flags, .pr-ribbon, .mt-view-tabs';
function wirePhoneStrips() {
    if (document.body.dataset.phoneStrips) return;
    document.body.dataset.phoneStrips = '1';
    const phone = window.matchMedia('(max-width: 700px)');
    const CUE = 32, GAP = 8;
    const clear = (strip) => {
        strip.classList.remove('whole-strip', 'fade-l', 'fade-r', 'scaled-1', 'scaled-2');
        ['width', 'flex', 'maxWidth', 'paddingRight'].forEach(k => { strip.style[k] = ''; });
        strip.style.removeProperty('--strip-end');
        [...strip.children].forEach(c => c.removeAttribute('data-snap'));
        if (strip._cue) { strip._cue.remove(); strip._cue = null; }
        strip._sig = '';
    };
    const fit = (strip) => {
        if (!phone.matches || strip.getBoundingClientRect().width === 0) { if (strip._sig) clear(strip); return; }
        const itemsOf = () => [...strip.children].filter(c => c.getBoundingClientRect().width > 0 && !c.classList.contains('strip-cue') && getComputedStyle(c).position !== 'absolute');
        const first = itemsOf();
        const sig = first.length + ':' + Math.round(window.innerWidth) + ':' + (strip.parentElement ? Math.round(strip.parentElement.clientWidth) : 0) + ':' + first.map(c => c.textContent.trim()).join('|');
        if (strip._sig === sig) return;
        clear(strip);
        const cs = getComputedStyle(strip);
        const gap = parseFloat(cs.columnGap) || 0;
        const reserve = parseFloat(cs.paddingRight) || 0;
        const avail = strip.clientWidth - reserve;
        strip._sig = sig;
        let items = itemsOf();
        if (!items.length || strip.scrollWidth <= strip.clientWidth + 1) return;
        // Three sizes of pill are tried, the drawn one first, and the one that needs the fewest pages wins: the smallest at which the labels still read.
        const room = avail - CUE - GAP;
        const plan = () => {
            items = itemsOf();
            const base = items[0].offsetLeft;
            const pos = items.map(c => ({ el: c, left: c.offsetLeft - base, w: c.getBoundingClientRect().width }));
            const pages = [];
            let start = 0;
            for (let i = 1; i <= pos.length; i++) {
                if (i === pos.length || pos[i].left + pos[i].w - pos[start].left > room) { pages.push([start, i - 1]); start = i; }
            }
            return { pos, pages };
        };
        strip.classList.add('whole-strip');
        let best = null;
        ['', 'scaled-1', 'scaled-2'].forEach(level => {
            strip.classList.remove('scaled-1', 'scaled-2');
            if (level) strip.classList.add(level);
            const p = plan();
            if (!best || p.pages.length < best.p.pages.length) best = { level, p };
        });
        strip.classList.remove('scaled-1', 'scaled-2');
        if (best.level) strip.classList.add(best.level);
        const { pos, pages } = plan();
        const widthOf = ([a, b]) => pos[b].left + pos[b].w - pos[a].left;
        const view = Math.max(...pages.map(widthOf));
        strip.classList.add('whole-strip');
        strip.style.flex = '0 0 auto';
        strip.style.maxWidth = 'none';
        strip.style.width = Math.ceil(widthOf(pages[0])) + 'px';
        strip.style.paddingRight = '0';
        strip.style.setProperty('--strip-end', Math.max(0, Math.ceil(view - widthOf(pages[pages.length - 1]) - gap)) + 'px');
        pages.forEach(([a]) => pos[a].el.setAttribute('data-snap', '1'));
        const starts = pages.map(([a]) => pos[a].left);
        const host = strip.parentElement;
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        const cue = document.createElement('button');
        cue.type = 'button';
        cue.className = 'strip-cue';
        cue.setAttribute('aria-label', 'More');
        host.appendChild(cue);
        strip._cue = cue;
        // The cue sits at the right edge of the room the row has, not against whichever item is last in view.
        const place = () => {
            cue.style.left = (strip.offsetLeft + avail - CUE) + 'px';
            cue.style.top = (strip.offsetTop + strip.offsetHeight / 2 - CUE / 2) + 'px';
        };
        // At rest the strip is exactly as wide as the page it shows, so a shorter page never lets the first item of the next peek in.
        let settle = 0;
        const resize = () => {
            const at = strip.scrollLeft;
            let k = 0;
            starts.forEach((x, i) => { if (Math.abs(x - at) < Math.abs(starts[k] - at)) k = i; });
            const w = Math.ceil(widthOf(pages[k])) + 'px';
            if (strip.style.width !== w) { strip.style.width = w; place(); }
        };
        const sync = () => {
            clearTimeout(settle);
            settle = setTimeout(resize, 90);
            const at = strip.scrollLeft;
            const last = at >= starts[starts.length - 1] - 2;
            strip.classList.toggle('fade-r', !last);
            strip.classList.toggle('fade-l', at > 2);
            cue.textContent = last ? '\u2039' : '\u203a';
            cue.setAttribute('aria-label', last ? 'Back to the first' : 'More');
        };
        cue.addEventListener('click', () => {
            const at = strip.scrollLeft;
            let k = starts.findIndex(x => x > at + 2);
            if (k < 0) k = 0;
            // The strip takes the target page's width first and then scrolls, so the move is one smooth glide and the width never changes under it.
            strip.style.width = Math.ceil(widthOf(pages[k])) + 'px';
            place();
            strip.scrollTo({ left: starts[k], behavior: 'smooth' });
        });
        strip.addEventListener('scroll', sync, { passive: true });
        place();
        sync();
    };
    // The sideways grids: a whole number of columns fills the room beside the pinned column, each column the same share of it.
    const GRIDS = [
        { scroller: '#player-leaderboard-container', table: '.lb-table-grid', pin: (t) => parseFloat(t.style.getPropertyValue('--lb-pin-w')) || 0, name: '--lb-cell-w', min: 46 },
        { scroller: '#view-team .dh-wrap', table: '.dominance-heatmap', pin: (t) => { const h = t.querySelector('th.dh-team-head'); return h ? h.getBoundingClientRect().width : 70; }, name: '--dh-cell-w', min: 46 },
        // League History's tables: the franchise pinned, the figures whole.
        { scroller: '.lh-scroll', table: '.lh-table', pin: (t) => { const h = t.querySelector('th:first-child'); return h ? h.getBoundingClientRect().width : 112; }, name: '--lh-col-w', min: 56 },
        // My Team's roster tables share one scroller, so the width is a property of the scroller.
        { scroller: '.mt-roster', table: '.mt-table', onScroller: true, pin: (t) => [...t.querySelectorAll('thead tr:first-child th.mt-slot, thead tr:first-child th.mt-player')].reduce((w, h) => w + h.getBoundingClientRect().width, 0), name: '--mt-col-w', min: 56 },
        // The full comparison screen: the category names pinned, a whole number of player columns beside them, a cue at the right edge.
        { scroller: '.cmpn-table-wrap', table: '.cmpn-table', cue: true, pin: (t) => { const h = t.querySelector('th.cmpn-corner'); return h ? (parseFloat(getComputedStyle(h).maxWidth) || h.getBoundingClientRect().width) : 72; }, name: '--cmp-col-w', min: 96 },
        // The Draft board: the round label and the reader's own column pinned, every team column one share of what is left.
        { scroller: '.dr-scroll', table: '.dr-results-table', custom: (sc, t) => {
            const round = (t.querySelector('th.dr-results-round') || { getBoundingClientRect: () => ({ width: 58 }) }).getBoundingClientRect().width;
            const teams = t.querySelectorAll('thead th.dr-results-team').length;
            // No team column is pinned at phone width: the reader's column scrolls with the rest and keeps its highlight.
            const total = Math.max(1, Math.floor((sc.clientWidth - round) / 84));
            const colW = (sc.clientWidth - round) / total;
            t.style.minWidth = Math.ceil(round + teams * colW) + 'px';
            t.dataset.phoneMin = '1';
            sc.style.scrollPaddingLeft = round + 'px';
        } }
    ];
    const fitGrids = () => {
        GRIDS.forEach(g => {
            try { fitGrid(g); } catch (e) { /* one grid never stops the others */ }
        });
    };
    // The round chevron of a sideways grid: at the right edge of the grid's room, scrolling a whole page of columns, back to the first from the last.
    const gridCue = (sc, colW, n) => {
        const host = sc.parentElement;
        if (!host) return;
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        let cue = host.querySelector(':scope > .strip-cue.grid-cue');
        if (sc.scrollWidth <= sc.clientWidth + 1) { if (cue) cue.remove(); return; }
        if (!cue) {
            cue = document.createElement('button');
            cue.type = 'button';
            cue.className = 'strip-cue grid-cue';
            cue.setAttribute('aria-label', 'More');
            host.appendChild(cue);
            cue.addEventListener('click', () => {
                const at = sc.scrollLeft;
                const page = colW * n;
                const max = sc.scrollWidth - sc.clientWidth;
                const next = at >= max - 2 ? 0 : Math.min(max, Math.round((at + page) / colW) * colW);
                sc.scrollTo({ left: next, behavior: 'smooth' });
            });
            sc.addEventListener('scroll', () => {
                const end = sc.scrollLeft >= sc.scrollWidth - sc.clientWidth - 2;
                cue.textContent = end ? '\u2039' : '\u203a';
            }, { passive: true });
        }
        cue.textContent = sc.scrollLeft >= sc.scrollWidth - sc.clientWidth - 2 ? '\u2039' : '\u203a';
        cue.style.left = (sc.offsetLeft + sc.clientWidth - 32 - 4) + 'px';
        const bar = host.querySelector(':scope > .cmpN-h');
        cue.style.top = ((bar ? bar.offsetTop + Math.max(0, (bar.offsetHeight - 32) / 2) : sc.offsetTop + 6)) + 'px';
    };
    const fitGrid = (g) => {
        {
            document.querySelectorAll(g.scroller).forEach(sc => {
                const t = sc.querySelector(g.table);
                const host = g.onScroller ? sc : t;
                // A Schedule face in the scroller is sized by its own day pass (myteam.js), not by the roster's column count.
                if (g.onScroller && sc.querySelector('.mt-nc')) { sc.style.removeProperty(g.name); sc.style.removeProperty('scroll-padding-left'); return; }
                if (!t) { if (g.onScroller) { sc.style.removeProperty(g.name); sc.style.removeProperty('scroll-padding-left'); } return; }
                if (!phone.matches || sc.getBoundingClientRect().width === 0) {
                    if (host) host.style.removeProperty(g.name);
                    sc.style.removeProperty('scroll-padding-left');
                    // Only what the phone pass itself set is undone: above 700px the board's own width is the board's.
                    if (g.custom && t.dataset.phoneMin) { t.style.removeProperty('min-width'); delete t.dataset.phoneMin; }
                    return;
                }
                if (g.custom) { g.custom(sc, t); return; }
                // The pinned width is read with this pass's own variable off, so the answer is the layout's and not a reading of the last answer. The comparison grid's pin is its CSS width, so its own column variable stays: taking it off changes the page's height and with it a classic scrollbar's 10px, which fitted the columns to a width the box does not keep.
                if (!g.cue) host.style.removeProperty(g.name);
                const pin = g.pin(t);
                const room = sc.clientWidth - pin;
                if (room < g.min) return;
                const n = Math.max(1, Math.floor(room / g.min));
                host.style.setProperty(g.name, (room / n).toFixed(2) + 'px');
                sc.style.scrollPaddingLeft = pin + 'px';
                if (g.cue) gridCue(sc, room / n, n);
                // A box that settles wider after this pass (a scrollbar gutter leaving) is fitted again once, so no sliver of the next column shows.
                const seen = sc.clientWidth;
                requestAnimationFrame(() => { if (sc.isConnected && sc.clientWidth !== seen && !queued) { queued = true; refit(); } });
            });
        }
    };
    let queued = false;
    const refit = () => {
        queued = false;
        obs.disconnect();
        document.querySelectorAll(PHONE_STRIPS).forEach(fit);
        fitGrids();
        obs.observe(document.body, WATCH);
    };
    const queue = () => { if (!queued) { queued = true; setTimeout(refit, 120); } };
    // A view that swaps its markup asks for the fit in the same task, so the first paint of the new markup is already fitted.
    window.leaguewiseFitNow = () => { queued = false; refit(); };
    // Class and hidden changes count too: a face that turns visible (the Draft board's mode switch) has to be sized when it shows.
    const WATCH = { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'hidden', 'style'] };
    const fadeOnly = (m) => m.attributeName === 'class' && m.oldValue !== null
        && m.oldValue.split(/\s+/).filter(c => c && c !== 'fade-l' && c !== 'fade-r').sort().join(' ')
            === m.target.className.split(/\s+/).filter(c => c && c !== 'fade-l' && c !== 'fade-r').sort().join(' ');
    const obs = new MutationObserver((muts) => {
        if (muts.every(m => m.type === 'childList'
            ? [...m.addedNodes, ...m.removedNodes].every(n => n.nodeType !== 1 || n.classList.contains('strip-cue'))
            : (fadeOnly(m) || m.target.classList && (m.target.classList.contains('strip-cue') || m.attributeName === 'style' && m.target.matches('.whole-strip, .lb-table-grid, .dominance-heatmap, .lh-table, .mt-roster, .dr-results-table, .dr-scroll'))))) return;
        queue();
    });
    obs.observe(document.body, WATCH);
    window.addEventListener('resize', queue);
    if (phone.addEventListener) phone.addEventListener('change', queue);
    else if (phone.addListener) phone.addListener(queue);
    queue();
}

// Team Metrics' Data Filters become one chip row at phone width: closed by default, the panel opening in place under it.
let phoneFiltersOpen = false;
function wirePhoneFiltersChip() {
    const bar = document.getElementById('control-panel');
    const body = bar && bar.querySelector('.control-panel-body');
    if (!bar || !body || document.getElementById('df-chip')) return;
    // The chip is the first item of the panel's own row, so the controls open to its right, and wherever the pager moves the panel the chip goes with it.
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.id = 'df-chip';
    chip.className = 'df-chip';
    chip.setAttribute('aria-expanded', 'false');
    chip.innerHTML = '<span class="df-chip-text">Filters</span><b class="df-chip-count" hidden></b><span class="df-chip-car" aria-hidden="true">&#9662;</span>';
    body.insertBefore(chip, body.firstChild);
    const count = chip.querySelector('.df-chip-count');
    const phone = window.matchMedia('(max-width: 700px)');
    const activeCount = () => {
        const off = ['toggle-cat', 'toggle-match'].filter(id => { const c = document.getElementById(id); return c && !c.checked; }).length;
        const m = /(\d+)\s+of\s+(\d+)/.exec((document.getElementById('df-team-summary') || {}).textContent || '');
        return off + (m && Number(m[1]) < Number(m[2]) ? 1 : 0);
    };
    const sync = () => {
        const collapsed = phone.matches && !phoneFiltersOpen;
        bar.classList.toggle('df-collapsed', collapsed);
        chip.setAttribute('aria-expanded', phoneFiltersOpen ? 'true' : 'false');
        const n = activeCount();
        if (count.textContent !== String(n)) count.textContent = String(n);
        count.hidden = n === 0;
    };
    chip.addEventListener('click', () => { phoneFiltersOpen = !phoneFiltersOpen; sync(); fitPhoneTeamView(true); });
    bar.addEventListener('change', () => setTimeout(sync, 0));
    bar.addEventListener('click', () => setTimeout(sync, 0));
    new MutationObserver(sync).observe(bar, { childList: true, subtree: true, characterData: true });
    if (phone.addEventListener) phone.addEventListener('change', sync);
    else if (phone.addListener) phone.addListener(sync);
    sync();
}

// The phone's bottom tab bar and the timeframe's place in the brand row.
function wirePhoneBottomBar() {
    const tabs = [
        ['tab-btn-team', 'Teams', '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>'],
        ['tab-btn-player', 'Players', '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4.5 4-6 8-6s7 1.5 8 6"/></svg>'],
        ['tab-btn-myteam', 'My Team', '<svg viewBox="0 0 24 24"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg>'],
        ['tab-btn-history', 'History', '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'],
        ['tab-btn-draft', 'Draft', '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/></svg>']
    ];
    let nav = document.getElementById('px-bottom');
    if (!nav) {
        nav = document.createElement('nav');
        nav.id = 'px-bottom';
        nav.className = 'px-bottom';
        nav.setAttribute('aria-label', 'Main tabs');
        nav.innerHTML = tabs.map(([id, label, icon]) => `<button type="button" data-tab="${id}" aria-label="${label}">${icon}<span>${label}</span></button>`).join('');
        document.body.appendChild(nav);
        nav.addEventListener('click', (e) => {
            const b = e.target.closest('button');
            const target = b && document.getElementById(b.dataset.tab);
            if (target && !target.disabled) target.click();
        });
        const sync = () => nav.querySelectorAll('button').forEach(b => {
            const t = document.getElementById(b.dataset.tab);
            b.classList.toggle('on', !!t && t.classList.contains('active'));
            b.disabled = !!t && t.disabled;
            b.setAttribute('aria-current', b.classList.contains('on') ? 'page' : 'false');
        });
        tabs.forEach(([id]) => {
            const t = document.getElementById(id);
            if (t) new MutationObserver(sync).observe(t, { attributes: true, attributeFilter: ['class', 'disabled'] });
        });
        sync();
    }
    const phone = window.matchMedia('(max-width: 700px)');
    const place = () => {
        const menu = document.querySelector('.timeframe-menu');
        const host = document.querySelector('.brand-header-right');
        const strip = document.querySelector('.tabs-container');
        if (!menu || !host || !strip) return;
        if (phone.matches) { if (menu.parentElement !== host) host.insertBefore(menu, host.firstChild); }
        else if (menu.parentElement !== strip) strip.appendChild(menu);
    };
    place();
    if (phone.addEventListener) phone.addEventListener('change', place);
    else if (phone.addListener) phone.addListener(place);
}

// The phone pager over Team Metrics: Season Trends, the Rankings box and the Category Heatmap as three pages, each the height of the screen under the masthead. CSS scroll-snap does the swiping; this puts the heatmap and the filters line where the pager needs them, keeps the dots in step with the scroll position, and lets a tap on a dot turn the page, since a swipe must never be the only way to do it.
function wireMobilePager() {
    const layout = document.querySelector('#view-team .layout');
    const dotsEl = document.querySelector('#view-team .tm-pager-dots');
    if (!layout || !dotsEl) return;
    const phone = window.matchMedia('(max-width: 700px)');

    // clientWidth is 0 and scrollLeft is always 0 whenever the layout is not the horizontal scroller the mobile CSS makes it, so the division is guarded.
    const syncDots = () => {
        const dots = [...dotsEl.querySelectorAll('.tm-pager-dot')];
        const page = layout.clientWidth ? Math.round(layout.scrollLeft / layout.clientWidth) : 0;
        const at = Math.max(0, Math.min(dots.length - 1, page));
        dots.forEach((d, idx) => {
            d.classList.toggle('active', idx === at);
            d.setAttribute('aria-selected', idx === at ? 'true' : 'false');
        });
    };

    // The heatmap band joins the layout as its third page and the filters line sits under the chart; both go back in their markup order (dots, band, filters) when the width stops being a phone's. Idempotent.
    const arrange = () => {
        const band = document.querySelector('#view-team .heatmap-band');
        const filters = document.getElementById('control-panel');
        const trends = layout.querySelector('.col-trends');
        if (!band || !filters || !trends) return;
        const third = dotsEl.querySelector('[data-page="2"]');
        if (phone.matches) {
            if (band.parentElement !== layout) layout.appendChild(band);
            band.classList.add('col', 'col-heatmap');
            if (filters.parentElement !== trends) trends.appendChild(filters);
            if (!third) {
                const dot = document.createElement('button');
                dot.type = 'button';
                dot.className = 'tm-pager-dot';
                dot.dataset.page = '2';
                dot.setAttribute('role', 'tab');
                dot.setAttribute('aria-selected', 'false');
                dot.setAttribute('aria-label', 'Category Heatmap');
                dotsEl.appendChild(dot);
            }
        } else {
            if (band.parentElement === layout) dotsEl.after(band);
            band.classList.remove('col', 'col-heatmap');
            if (filters.parentElement === trends) band.after(filters);
            if (third) third.remove();
            layout.scrollLeft = 0;
        }
        syncDots();
    };

    layout.addEventListener('scroll', syncDots, { passive: true });

    // The scroll is instant, not smooth, because a smooth scrollTo never animated here. A real swipe keeps its native momentum, and the dot is the secondary way to turn a page.
    dotsEl.addEventListener('click', (e) => {
        const dot = e.target.closest('.tm-pager-dot');
        if (!dot) return;
        const i = [...dotsEl.querySelectorAll('.tm-pager-dot')].indexOf(dot);
        layout.scrollTo({ left: i * layout.clientWidth, behavior: 'instant' });
        syncDots();
    });

    arrange();
    const onChange = () => { arrange(); fitPhoneTeamView(true); };
    if (phone.addEventListener) phone.addEventListener('change', onChange);
    else if (phone.addListener) phone.addListener(onChange);

    // The view's height is the screen under the masthead. Its natural height is its content's, which is a page taller or shorter than the screen depending on the league, so the pages could not fill it without a measure.
    if (typeof ResizeObserver !== 'undefined') {
        let queued = false;
        const again = () => {
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => { queued = false; fitPhoneTeamView(); });
        };
        const ro = new ResizeObserver(again);
        const results = document.getElementById('results');
        const strip = document.querySelector('.tabs-container');
        if (results) ro.observe(results);
        if (strip) ro.observe(strip);
    }
    window.addEventListener('resize', () => fitPhoneTeamView());
}

// Sets the Team Metrics view's height to the screen under the masthead on a phone and clears it elsewhere; when the height moved, the two columns are drawn again so the chart is made at its panel's size.
/**
 * Fits the Team Metrics view to the viewport on a phone.
 *
 * @param {boolean} [force] Draw the columns again even if the height did not move.
 * @returns {void}
 */
function fitPhoneTeamView(force = false) {
    const view = document.getElementById('view-team');
    if (!view) return;
    if (!window.matchMedia('(max-width: 700px)').matches) {
        if (view.style.height) view.style.removeProperty('height');
        return;
    }
    if (getComputedStyle(view).display === 'none') return;
    const top = view.getBoundingClientRect().top + window.scrollY;
    const bar = document.getElementById('px-bottom');
    const barH = bar && bar.offsetHeight ? bar.offsetHeight : 0;
    const h = Math.max(360, Math.round(window.innerHeight - top - 12 - barH));
    if (view.style.height === `${h}px` && !force) return;
    view.style.height = `${h}px`;
    if (AppState.teamStats && AppState.teamStats.length) { renderLeftColumn(); renderRightColumn(); }
}

document.addEventListener('DOMContentLoaded', async () => {

    // Redirect to a full tab when opened as a small popup, but only on the first, untagged load. The tab it opens carries ?tab=1 and skips this check, because on Firefox for Android every surface is under 800px and would otherwise open tabs forever. A per-tab sessionStorage marker also stops a reload of the stripped URL from spawning a duplicate. It is not browser.storage.session, which is extension-wide.
    const params = new URLSearchParams(location.search);
    // A sidebar surface is narrow by design, so without this it would see its own width and reopen itself as a full tab. The surface counts as already landed, like the tab does, and is checked before the width read.
    const isSidebarSurface = params.get('surface') === 'sidebar';
    let alreadyTab = params.has('tab') || isSidebarSurface;
    try { alreadyTab = alreadyTab || sessionStorage.getItem('lwTab') === '1'; } catch { /* storage disabled - fall back to the URL tag alone */ }
    // The comparison is <= because a browser-action popup is clamped to 800px wide, so a strict test never recognised one. A popup that opened at exactly 800 rendered the dashboard into a viewport with no height. A popup can never be wider than the clamp, so this means always redirect a popup, with the popup harness's width ceiling as a second guard.
    if (!alreadyTab && window.innerWidth <= 800) {
        browser.tabs.create({ url: browser.runtime.getURL("dashboard.html") + "?tab=1" });
        window.close();
        return;
    }
    // On the tagged load the tab is marked and the query is dropped so the URL bar reads clean. Only the tab parameter goes, so any other parameter is preserved across a reload.
    if (params.has('tab')) {
        try { sessionStorage.setItem('lwTab', '1'); } catch { /* storage disabled - the load still works, only the reload guard is lost */ }
        params.delete('tab');
        const qs = params.toString();
        history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
    }
    // The marker is stamped on the root element before anything renders, as theme-init.js does for style and theme, so the stylesheet can trim the surface with attribute selectors and renderers can read it back. It stays on the URL so a reload of the sidebar still finds it.
    if (isSidebarSurface) document.documentElement.setAttribute('data-surface', 'sidebar');

    // The theme toggle is independent of league data, so it is wired first and works immediately.
    setupOddsPreference();
    setupDiagnosticPreference();
    setupStylePreference();
    setupThemeToggle();

    // The two pop-out overlays are wired once. Their buttons live in a view that only appears after data loads, but the elements exist in the static markup from the start.
    setupPopouts();
    // The per-card pop-out's close button. Its open triggers live on cards rebuilt on every scoreboard render, so those are wired where the cards are drawn.
    setupCardPopout();

    // The Roto Race fills in as the bulk weekly fetch's chunks land, so this hook re-renders the trends box on each debounced chunk, gated to roto and wired here so players.js need not import graphs.js. It also promotes the timeframe pills the first time the started-day harvest lands. A head-to-head league's day race arrives through the same hook and re-renders the Rankings box when that state changes.
    let lastMatchupRaceState = null;
    setWeeklyProgressHook(() => {
        if (!AppState.isRotoLeague) {
            const state = matchupRaceStatus(AppState.loadedSport).state;
            if (state !== lastMatchupRaceState) { lastMatchupRaceState = state; renderLeftColumn(); }
            return;
        }
        renderRightColumn();
        syncRotoTimeframePills();
        // The Rankings box has to re-fit too. Its category races only become drawable once the roto series has data, and the pill row appearing changes the height every box is measured against. Without this the category layout keeps what it computed at the smaller early size.
        renderLeftColumn();
    });

    // Player Metrics refreshes after any successful league fetch. This lives on the shared hook, not the Fetch Data handler, because the My Leagues picker auto-fetches without that handler and would show the previous league's players. It is registered before checkAuth because the picker can start a fetch the moment it exists.
    setPostFetchHook(async ({ reopenPlayerId }) => {
        // A league switch landing on a tab the new league disables goes to Team Metrics instead of leaving an unreachable tab on screen. The disabled flags have already been refreshed by the time this hook fires.
        if (tabBtnMyTeam.classList.contains('active') && tabBtnMyTeam.disabled) switchTab('team');

        // The same redirect for the Draft tab, which a league switch can hide outright, so a league with no board basis never leaves the Draft tab active but gone from the row.
        if (tabBtnDraft && tabBtnDraft.classList.contains('active') && tabBtnDraft.style.display === 'none') switchTab('team');

        // The player pool was already invalidated for the new year, league or sport, but nothing re-triggers a load for a Player Metrics tab on screen, so it is refreshed here.
        const playerView = document.getElementById('view-player');
        if (!playerView || playerView.style.display === 'none') return;
        await loadPlayerTabIfNeeded();
        // The prior drill-down reopens only if that player is in the new league's pool. A year change keeps the id and reopens with fresh data, while a sport or league change closes the drill-down back to the leaderboard. The check is on pool membership, not sport strings, so a same-sport league switch lands cleanly too.
        if (reopenPlayerId !== null) {
            if (AppState.playerData.some(p => p.id === reopenPlayerId)) openPlayerDetail(reopenPlayerId, true);
            else closePlayerDetail();
        }
    });

    // One delegated listener serves every info mark on the page, including those panels render later. It is wired once, before anything renders.
    setupHintTooltips();
    // The rank explainer's touch form, a touch-and-hold on the chips, which is the equivalent of the desktop hover-and-wait that a tap cannot sustain.
    setupLongPressDisclosures();
    // Dot indicator wiring for the mobile pager only, since the swipe itself is CSS scroll-snap.
    wireMobilePager();
    wirePhoneMasthead();

    // Logging in with the dashboard already open heals it on any tab without a manual refresh. Two failures are retried in order, since the pool is fetched against the league payload. First, the league itself was refused, so it is re-fetched and the post-fetch hook rebuilds every tab. Second, the league loaded but the pool was refused, so only that is re-fetched. Anything else is the ordinary logged-in startup.
    document.addEventListener('leaguewise:auth-restored', async () => {
        if (AppState.leagueDataError) {
            AppState.leagueDataError = null;
            await fetchEspnData();
            return;
        }
        await retryPlayerPoolAfterLogin();
    });

    // Install first and log in second is the normal first run, so the dashboard watches for the cookies arriving instead of waiting for a refresh. It is wired before the first check, so a login that lands mid-startup is still noticed.
    setupAuthWatchers();
    await checkAuth();
    await loadStoredSettings();
    wireSettingsOrder();

    // 2. Main API Binding
    document.getElementById('fetch-btn').addEventListener('click', () => fetchEspnData());

    // The load-back of a full archive makes no ESPN call. The banner and the disabled fetch button and diagnostic panel are the one visible difference from a fetched league, since the tabs, the timeframe and the exports use the same rendering path.
    const renderArchiveState = () => {
        const info = archiveInfo();
        const banner = document.getElementById('archive-banner');
        const fetchBtn = document.getElementById('fetch-btn');
        const diagnosticCheckbox = document.getElementById('pref-diagnostic');
        if (info) {
            const written = new Date(info.writtenAt);
            const when = Number.isNaN(written.getTime())
                ? 'an unknown date'
                : written.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
            banner.textContent = `Archived league, read from your file - written ${when} by Leaguewise ${info.extensionVersion}`;
            banner.title = 'Every fetch button here would need ESPN - an archived session never calls it, so they are turned off rather than left to fail.';
            banner.style.display = '';
            fetchBtn.disabled = true;
            fetchBtn.title = 'This league was opened from an archive file - fetching would need ESPN, which an archived session never calls.';
            // Off and disabled, not just off, because the checkbox is the one way a reader could bring the panel back. Nothing in it can reach ESPN for an archived league, so this is honesty about what the buttons say they do.
            setDiagnosticPanelEnabled(false);
            if (diagnosticCheckbox) {
                diagnosticCheckbox.checked = false;
                diagnosticCheckbox.disabled = true;
                diagnosticCheckbox.title = 'Nothing to fetch on an archived league.';
            }
        } else {
            banner.style.display = 'none';
            fetchBtn.disabled = false;
            fetchBtn.title = '';
            if (diagnosticCheckbox) {
                diagnosticCheckbox.disabled = false;
                diagnosticCheckbox.title = '';
            }
        }
    };

    document.getElementById('open-archive-btn').addEventListener('click', () => {
        document.getElementById('archive-file-input').click();
    });
    document.getElementById('archive-file-input').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        e.target.value = ''; // the SAME file picked twice in a row must still fire 'change'
        if (!file) return;
        const statusEl = document.getElementById('archive-file-status');
        statusEl.style.display = '';
        statusEl.className = 'archive-file-status';
        statusEl.textContent = 'Reading...';
        const result = await loadArchiveFile(file);
        if (result.ok) {
            statusEl.style.display = 'none';
            renderArchiveState();
            return;
        }
        statusEl.className = 'archive-file-status archive-file-status-error';
        if (result.summaryZip) {
            // A summary export is named for what it is and not read as a JSON parse failure, because it has no league payload to boot the dashboard from. Its CSVs are still in the file the reader picked, and offering the file back leaves them with something useful. This app has a zip writer and no zip reader.
            statusEl.textContent = 'This is a summary archive - it opens in a spreadsheet; the full archive opens here. ';
            const again = document.createElement('button');
            again.type = 'button';
            again.textContent = 'Save it again';
            again.className = 'archive-file-status-link';
            again.addEventListener('click', () => {
                const url = URL.createObjectURL(file);
                const a = document.createElement('a');
                a.href = url;
                a.download = file.name || 'leaguewise-archive-summary.zip';
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
            });
            statusEl.appendChild(again);
        } else if (result.parseError) {
            statusEl.textContent = `This file isn't a Leaguewise archive - it could not be read as JSON (${result.parseError}).`;
        } else {
            statusEl.textContent = `This file has ${result.issues.length} problem${result.issues.length === 1 ? '' : 's'}: `
                + result.issues.map(i => `${i.path} - ${i.why}`).join('; ');
        }
    });

    // Re-filter the My Leagues picker to the selected sport. Discovery keeps the full cross-sport list in memory, so this only re-renders the visible options, and a switch that hides the current pick resets it to the placeholder without fetching.
    document.getElementById('sport').addEventListener('change', renderMyLeaguesOptions);

    // The gear toggles the collapsed league-settings fields back open. It is class-based so the open and close ease through the settings bar's transition.
    document.getElementById('settings-toggle-btn').addEventListener('click', () => {
        const collapsed = document.getElementById('settings-bar').classList.toggle('collapsed');
        // The handle rides the rail's outer edge, so it moves with it.
        document.body.classList.toggle('settings-closed', collapsed);
    });
    // There is deliberately no re-render here. The bar is 64px of page height, and re-fitting My Team after the transition made the roster overflow for the animation and then snap its type to a new size. Team Metrics and Player Metrics run no JS on this toggle, and My Team can do the same, since its roster takes the height left and scrolls internally. The density chosen on entry stays, so the size is stable.

    document.getElementById('toggle-cat').addEventListener('change', renderRightColumn);
    document.getElementById('toggle-match').addEventListener('change', renderRightColumn);

    // The Rankings box's header tabs switch it between Team Rankings, where each section can flip to its own pie, and Category Rankings. Only the Rankings box re-renders.
    const setRankingsBoxView = (view) => {
        if (AppState.rankingsBoxView === view) return;
        AppState.rankingsBoxView = view;
        renderLeftColumn();
    };
    document.getElementById('rankings-tab-standings').addEventListener('click', () => setRankingsBoxView('standings'));
    document.getElementById('rankings-tab-category').addEventListener('click', () => setRankingsBoxView('category'));
    // The third tab, Playoff Odds, is hidden by the box chrome for a league shape not drawn yet, but binding the listener costs nothing either way.
    document.getElementById('rankings-tab-playoffs').addEventListener('click', () => setRankingsBoxView('playoffs'));
    // The fourth tab, Head-to-Head, shows the series matrix with the whole box and stays hidden until the league has a series to draw.
    document.getElementById('rankings-tab-h2h').addEventListener('click', () => setRankingsBoxView('h2h'));

    // The main Data Filters bar is no longer collapsible, so it has no toggle to wire here. Both pop-outs' docked filter boxes still collapse, and collapsing hands the height to the chart underneath, so each re- renders into the taller slot.
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

    // Re-rendering the leaderboard on every keystroke is wasted work while the reader is mid-word, so the render is debounced until typing pauses. The query itself still updates immediately, so the input's displayed value is never delayed.
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

    // Scrolling changes which rows are on screen, one of the two signals that re-tier the weekly-data queue. It is throttled with rAF, since once per frame at most is plenty, and is a no-op when no bulk fetch is running.
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
        // Team breakout: the tab SET a selection was made from is different once availability changes (fantasy teams disappear under Free Agents, pro teams under On Teams), so a stale id would silently filter to nothing, or worse, to a different team that happens to share the id space. Same reset normalizePlayerViewStateForLeague does on a league switch, for the same reason.
        AppState.playerBreakoutFilter = { kind: 'all', id: null };
        renderPlayerLeaderboard();
    });

    // Delegated, since the rail row is rebuilt on every render and a delegated click avoids re-attaching a listener to each button. The data-kind selector catches the All chip, a fantasy team crest and a club crest with one selector.
    document.getElementById('player-breakout-slot')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-kind]');
        if (!btn) return;
        const kind = btn.dataset.kind;
        const id = btn.dataset.id ? Number(btn.dataset.id) : null;
        AppState.playerBreakoutFilter = { kind, id };
        renderPlayerLeaderboard();
    });

    // Export and Recap live in the tab bar inside #results, so they only appear once data has loaded. Both modals re-read current state on every open, so no other wiring is needed.
    document.getElementById('export-btn').addEventListener('click', openExportModal);
    document.getElementById('recap-btn').addEventListener('click', openRecapModal);

    // The icon legend popover lists the crown, rank medals and trend arrows. Any click outside the menu, or Escape, closes it, and the button's own stopPropagation keeps its toggle from being re-closed by the same document handler.
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

    // The timeframe scope chip holds the two segmented controls in a popover, on the same pattern as the legend popover above, including stopPropagation and the two document-level listeners. A pill click closes it too, but that half lives in controls.js, which alone knows a pill was clicked.
    const timeframeBtn = document.getElementById('timeframe-scope-btn');
    const timeframePopover = document.getElementById('timeframe-toggle');
    if (timeframeBtn && timeframePopover) {
        const setTimeframeOpen = (open) => {
            timeframePopover.hidden = !open;
            timeframeBtn.setAttribute('aria-expanded', String(open));
        };
        timeframeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            setTimeframeOpen(timeframePopover.hidden);
        });
        document.addEventListener('click', (e) => {
            if (!timeframePopover.hidden && !timeframePopover.contains(e.target) && e.target !== timeframeBtn) closeTimeframePopover();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !timeframePopover.hidden) closeTimeframePopover();
        });
    }

    // 5. Debug Panel Bindings
    document.getElementById('debug-download-btn').addEventListener('click', downloadDebugData);
    // Download All runs every harvest for the league and season on screen in a fixed order, cheapest first, then writes the zip with its INDEX first. capture-all.js keeps the order and count, and the steps are built where their calls live. One function draws the panel from one state object, so the estimate, the progress line and the summary cannot disagree.
    const cap = { phase: 'idle', league: null, estimate: null, live: new Map(), startReq: new Map(), progress: null, ledger: null, file: null, cancelRequested: false, past: null };
    const capKey = (r) => `${r.kind}${r.season ? `:${r.season}` : ''}`;
    const capSize = (b) => (b === null || b === undefined ? '?' : (b >= 1e6 ? `${(Math.round(b / 1e5) / 10)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`));
    const capEsc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const everySeasonOn = () => !!document.getElementById('debug-every-season')?.checked;
    const pastYears = () => (debugContextFor('league-history') || []).map(s => s && s.seasonId);

    // Before the press: this season's steps from the league on screen, plus ONE aggregate row for the past seasons when the box is ticked. Those steps exist only once league-history has answered, so until then the row says what a season costs and nothing more.
    function captureEstimateNow() {
        if (!AppState.apiData) return null;
        const est = captureEstimate(orderedCaptureSteps());
        const rows = [...est.rows];
        let requests = est.requests, bytes = est.bytes, unknown = est.unknown, toFetch = est.toFetch;
        if (everySeasonOn()) {
            const years = pastYears();
            const steps = years.length ? seasonCaptureSteps(years) : [];
            if (steps.length) {
                const pe = captureEstimate(steps);
                const seasons = new Set(steps.map(s => s.season)).size;
                rows.push({ kind: 'past seasons', state: 'to fetch', reason: null, requests: pe.requests, bytes: pe.unknown ? null : pe.bytes, note: `${seasons} seasons, 3 requests a season` });
                requests += pe.requests; bytes += pe.bytes; unknown += pe.unknown ? 1 : 0; toFetch += 1;
            } else {
                rows.push({ kind: 'past seasons', state: 'to fetch', reason: null, requests: null, bytes: null, note: '3 requests a season' });
                unknown += 1; toFetch += 1;
            }
        }
        return { rows, requests, bytes, unknown, toFetch };
    }

    const capRowHtml = (r) => {
        const live = cap.live.get(capKey(r));
        const state = live ? live.state : (cap.phase === 'running' && r.state === 'to fetch' ? 'waiting' : r.state);
        const requests = live ? live.requests : r.requests;
        const quiet = state === 'held' || state === 'skipped';
        const note = live && live.note ? live.note : (r.note || r.reason || '');
        const word = state === 'stopping' ? 'stops after this kind' : state;
        return `<div class="cap-row"><span class="cap-kind">${capEsc(r.kind)}${r.season ? ` ${r.season}` : ''}</span><span class="cap-st cap-${capEsc(state.replace(/ /g, '-'))}">${capEsc(word)}</span>`
            + `<span class="cap-n">${quiet || requests === null || requests === undefined ? '' : capEsc(requests)}</span>`
            + `<span class="cap-b">${quiet || live || r.bytes === undefined ? '' : capEsc(capSize(r.bytes))}</span><span class="cap-note">${capEsc(note)}</span></div>`;
    };
    const capHead = '<div class="cap-row cap-head"><span>Kind</span><span>State</span><span class="cap-n">Requests</span><span class="cap-b">Size</span><span></span></div>';

    function renderCapturePanel() {
        const rowsHost = document.getElementById('capture-rows');
        const lineHost = document.getElementById('capture-line');
        const btn = document.getElementById('debug-download-all-btn');
        const box = document.getElementById('debug-every-season');
        if (!rowsHost || !lineHost || !btn) return;
        if (cap.league !== AppState.apiData) { cap.phase = 'idle'; cap.league = AppState.apiData; cap.live.clear(); cap.ledger = null; cap.file = null; }
        const running = cap.phase === 'running';
        if (box) box.disabled = running;
        btn.disabled = false;
        btn.textContent = running ? (cap.cancelRequested ? 'Cancelling' : 'Cancel') : '⬇ Download All';
        if (running && cap.cancelRequested) btn.disabled = true;
        let rows = [], line = '';
        if (cap.phase === 'done' && cap.ledger) {
            rows = cap.ledger.kinds.filter(k => !k.season);
            const past = cap.ledger.kinds.filter(k => k.season);
            if (past.length) {
                const ok = past.filter(k => ['fetched', 'held'].includes(k.state)).length;
                rows = rows.concat([{ kind: 'past seasons', state: ok === past.length ? 'fetched' : 'partial', requests: past.reduce((s, k) => s + (k.requests || 0), 0), bytes: null,
                    note: ok === past.length ? `${new Set(past.map(k => k.season)).size} seasons` : `${ok} of ${past.length}${past.filter(k => !['fetched', 'held'].includes(k.state)).map(k => ` · ${k.kind} ${k.season} ${k.state}${k.error ? ` (${k.error})` : ''}`).join('')}` }]);
            }
            const count = (...s) => cap.ledger.kinds.filter(k => s.includes(k.state)).length;
            const bad = cap.ledger.kinds.filter(k => !['held', 'fetched', 'skipped'].includes(k.state));
            line = `<span class="cap-total">${cap.ledger.requests} requests · ${count('fetched')} fetched, ${count('held')} held, ${count('skipped')} skipped`
                + (bad.length ? ` · ${bad.length} incomplete: ${bad.map(k => `${k.kind}${k.season ? ` ${k.season}` : ''} ${k.state}`).join(', ')}` : '')
                + (cap.ledger.cancelled ? ' · cancelled' : '') + '</span>' + (cap.file ? `<span class="cap-saved">${capEsc(cap.file)}</span>` : '');
        } else {
            const est = cap.estimate && cap.phase === 'running' ? cap.estimate : captureEstimateNow();
            cap.estimate = est;
            rows = est ? est.rows : [];
            if (running && cap.progress) {
                const p = cap.progress;
                const shown = Math.min(p.done + (p.state === 'running' ? 1 : 0), p.total);
                const pct = p.estimatedRequests ? Math.min(100, Math.round(100 * p.requests / p.estimatedRequests)) : 0;
                line = `<span class="cap-progress">${p.label}${shown} of ${p.total} · ${capEsc(p.kind)} · ${p.requests} of about ${p.estimatedRequests} requests</span><span class="cap-bar"><i style="width:${pct}%"></i></span>`;
            } else if (est) {
                line = `<span class="cap-total">${est.toFetch} to fetch · ${est.requests} requests · ${capSize(est.bytes)}${est.unknown ? ` and ${est.unknown} unknown` : ''}</span>`;
            }
        }
        lineHost.innerHTML = line;
        const half = Math.ceil(rows.length / 2);
        rowsHost.innerHTML = rows.length ? `<div class="cap-grid"><div>${capHead}${rows.slice(0, half).map(capRowHtml).join('')}</div><div>${capHead}${rows.slice(half).map(capRowHtml).join('')}</div></div>` : '';
    }

    // The progress for one run: which kind, its own request count (the run's count at its first event subtracted from the run's count now), and the state words the rows draw. A cancel asked while a kind runs changes that kind's word to "stops after this kind"; the contract takes effect between steps, so the kind finishes and the rest read cancelled.
    const capProgress = (label) => (p) => {
        cap.progress = { ...p, label };
        const key = capKey({ kind: p.kind, season: null });
        if (!cap.startReq.has(key) && p.state === 'running') cap.startReq.set(key, p.requests);
        const start = cap.startReq.get(key) ?? p.requests;
        cap.live.set(key, { state: p.state === 'running' && cap.cancelRequested ? 'stopping' : p.state, requests: p.requests - start });
        renderCapturePanel();
    };

    const downloadAllBtn = document.getElementById('debug-download-all-btn');
    downloadAllBtn.addEventListener('click', async () => {
        if (cap.phase === 'running') {
            cap.cancelRequested = true;
            cap.live.forEach((v) => { if (v.state === 'running') v.state = 'stopping'; });
            renderCapturePanel();
            return;
        }
        if (!AppState.apiData) { downloadAllDebugData(); return; }
        cap.phase = 'running'; cap.league = AppState.apiData; cap.cancelRequested = false; cap.live.clear(); cap.startReq.clear(); cap.progress = null; cap.ledger = null; cap.file = null;
        cap.estimate = captureEstimateNow();
        renderCapturePanel();
        try {
            const shouldCancel = () => cap.cancelRequested;
            const ledger = await captureAll(orderedCaptureSteps(), { onProgress: capProgress('Kind '), shouldCancel });
            // EVERY SEASON, when its box is ticked: a second run, because which seasons the league has is something the first run fetches. One ledger, the past seasons' rows after this season's, so the index reads as one press.
            if (everySeasonOn() && !cap.cancelRequested) {
                const past = await captureAll(seasonCaptureSteps(pastYears()), { onProgress: (p) => { cap.progress = { ...p, label: 'Past seasons · ' }; cap.live.set('past seasons', { state: 'running', requests: p.requests }); renderCapturePanel(); }, shouldCancel });
                ledger.kinds.push(...past.kinds);
                ledger.requests += past.requests;
                ledger.complete = ledger.complete && past.complete;
                ledger.cancelled = ledger.cancelled || past.cancelled;
            }
            cap.file = await downloadAllDebugData(null, { ledger });
            cap.ledger = ledger;
        } finally {
            cap.phase = 'done';
            if (!cap.ledger) cap.phase = 'idle';
            cap.cancelRequested = false;
            renderCapturePanel();
        }
    });
    document.getElementById('debug-every-season')?.addEventListener('change', renderCapturePanel);

    // Delegated, because the buttons are rebuilt every time a response lands or the shown kind changes, so anything bound to an individual button would be thrown away with it.
    document.getElementById('debug-kinds').addEventListener('click', (e) => {
        const btn = e.target.closest('.debug-kind');
        if (btn && !btn.disabled) pinDebugKind(btn.dataset.kind);
    });
    // The panel's details element skips serializing its payload while collapsed, so it is caught up whenever it opens, in case its active context changed meanwhile. Opening is also the trigger for the drill-down's on-demand diagnostic capture, which is a no-op unless a player is open with nothing captured yet.
    const debugPanel = document.getElementById('debug-panel');
    // The panel does not push the page. The rule for transient panels still governs the rank explanation, but the diagnostic panel is a setting that stays on, so it is an overlay drawer that never grows the document past the viewport.
    debugPanel.addEventListener('toggle', () => {
        refreshDebugPanel();
        if (debugPanel.open) ensurePlayerDetailDiagnostic();
        // The estimate depends on the league, which can change while the panel sits collapsed, so it is drawn on every open rather than once at wiring time.
        if (debugPanel.open) renderCapturePanel();
    });

    // 6. Tab Navigation Bindings
    const tabBtnTeam = document.getElementById('tab-btn-team');
    const tabBtnPlayer = document.getElementById('tab-btn-player');
    const viewTeam = document.getElementById('view-team');
    const viewPlayer = document.getElementById('view-player');

    const tabBtnMyTeam = document.getElementById('tab-btn-myteam');
    const viewMyTeam = document.getElementById('view-myteam');
    const tabBtnHistory = document.getElementById('tab-btn-history');
    const viewHistory = document.getElementById('view-history');
    // The Draft tab's button and view are ordinary markup, always present and never conditional, since the dev gate that hid it has been removed outright.
    const tabBtnDraft = document.getElementById('tab-btn-draft');
    const viewDraft = document.getElementById('view-draft');

    // Each tab says here how to show itself, and the registry owns both call sites, a click on the tab button and a league fetch committing while that tab is on screen. A new tab registers beside its siblings and is correct on a league switch for free.
    registerLeagueView('team', {
        show: () => {
            setActiveDebugKind('team');
            // Re-render on return, because the layout-measuring steps read zero heights for anything measured while this tab was hidden, which dropped the inline pies until another render ran. Which face the tab wears is decided inside renderTeamMetricsTab, so this call site and the one in data.js cannot disagree.
            renderTeamMetricsTab();
        }
    });
    registerLeagueView('player', {
        show: () => {
            // A drill-down left open from a previous visit stays open, so the panel is matched to whichever view is actually showing and not assumed to be the leaderboard.
            setActiveDebugKind(AppState.selectedPlayerId !== null ? 'player-detail' : 'player-pool');
            loadPlayerTabIfNeeded();
        }
    });
    registerLeagueView('myteam', {
        show: () => {
            // The roster is this tab's subject, so the panel offers the roster kind. An open drill-down still wins. The roster kind is only populated once the period's roster has landed, and until then the panel shows its own "nothing captured" line.
            setActiveDebugKind(AppState.selectedPlayerId !== null ? 'player-detail' : 'roster');
            // Re-fit from scratch on entry. What was measured last time was measured for whatever league, roster and window size were on screen then, and any of the three can have changed while this tab was away.
            invalidateMyTeamLayout();
            renderMyTeamTab();
        }
    });
    registerLeagueView('history', {
        // History fetches a payload per past season, so entry is where that starts. The view keeps its own per-league state and re-renders from it, so a second entry costs nothing.
        show: () => { renderHistoryTab(); }
    });
    registerLeagueView('draft', {
        // The Draft tab reads the pool the Player tab fetches and makes no request of its own, so entry is a render and nothing more. reset clears which face was open, because a face chosen on one league must not decide what the next league opens on.
        show: () => {
            setActiveDebugKind('player-pool');
            renderDraftTab();
        },
        reset: () => { resetDraftView(); }
    });

    function switchTab(name) {
        // The disabled attribute already stops a click on the tab button. This guard covers any other caller that invokes switchTab for My Team directly, such as a keyboard shortcut or a deep link.
        if (name === 'myteam' && seasonState(AppState.apiData) === SEASON_STATE.PRE_DRAFT) return;
        const isTeam = name === 'team';
        const isMine = name === 'myteam';
        const isHistory = name === 'history';
        const isDraft = name === 'draft';
        tabBtnTeam.classList.toggle('active', isTeam);
        tabBtnPlayer.classList.toggle('active', name === 'player');
        tabBtnMyTeam.classList.toggle('active', isMine);
        if (tabBtnHistory) tabBtnHistory.classList.toggle('active', isHistory);
        if (tabBtnDraft) tabBtnDraft.classList.toggle('active', isDraft);
        viewTeam.style.display = isTeam ? 'flex' : 'none';
        viewPlayer.style.display = name === 'player' ? 'flex' : 'none';
        viewMyTeam.style.display = isMine ? 'flex' : 'none';
        if (viewHistory) viewHistory.style.display = isHistory ? 'flex' : 'none';
        if (viewDraft) viewDraft.style.display = isDraft ? 'flex' : 'none';
        // The tabs with no timeframe. This changes visibility only, so the container keeps its place and nothing in the row moves. The draft reads projections for a season not yet played, so there is no window over it to choose.
        setTimeframeVisible(!isHistory && !isDraft);
        showLeagueView(name);
        // The phone's Team Metrics pages are measured once the view is displayed.
        if (isTeam) fitPhoneTeamView();
    }

    // The pool decides both preseason faces. They are built from drafted rosters times projected lines, and the pool lands after the league payload, so the first render draws the ordinary tab. The draft picks redraw once they resolve instead of leaving "Undrafted" on screen, and the open drill-down is refreshed in a way that keeps a group comparison open.
    document.addEventListener('leaguewise:draft-picks-ready', () => {
        if (isPreseason(seasonState(AppState.apiData))) {
            renderActiveLeagueView();
            return;
        }
        if (AppState.selectedPlayerId !== null) refreshOpenPlayerDetail();
        const myTeamView = document.getElementById('view-myteam');
        if (myTeamView && myTeamView.style.display !== 'none') renderMyTeamTab();
        // The frozen post-draft board reads the draft picks, asked for the same way My Team's row above is. A first paint before the request resolves shows nothing instead of a wrong answer, and this redraws once it lands.
        const draftView = document.getElementById('view-draft');
        if (draftView && draftView.style.display !== 'none') renderDraftTab();
    });

    document.addEventListener('leaguewise:player-pool-ready', () => {
        if (!isPreseason(seasonState(AppState.apiData))) {
            // A played league is not redrawn by the pool, since its other tabs load the pool themselves, but the Draft tab's recap is built from it and loads nothing of its own. Without this a league switch made with the tab open kept a raw id for every pick until the reader left and came back.
            const draftView = document.getElementById('view-draft');
            if (draftView && draftView.style.display !== 'none') renderDraftTab();
            return;
        }
        renderActiveLeagueView();
    });

    tabBtnTeam.addEventListener('click', () => switchTab('team'));
    tabBtnPlayer.addEventListener('click', () => switchTab('player'));
    tabBtnMyTeam.addEventListener('click', () => switchTab('myteam'));
    if (tabBtnHistory) tabBtnHistory.addEventListener('click', () => switchTab('history'));
    if (tabBtnDraft) tabBtnDraft.addEventListener('click', () => switchTab('draft'));

    // Dev preview and capture only. The startTab parameter switches to a tab with no click, so a headless capture of any non-default tab needs neither a click nor resolved async data. It is deliberately not named tab, because the popup-redirect gate reads has('tab') for any value and would have been tripped. It does nothing in the shipped extension.
    const startTab = params.get('startTab');
    if (['team', 'player', 'myteam', 'history', 'draft'].includes(startTab)) switchTab(startTab);

    // The shipped extension's own version of the dev-only switch above, since a reader who opened Leaguewise beside the draft room did not open it to see Team Metrics. It runs before any data has loaded and only decides which tab is active when data lands, and the draft view's sidebar check then forces the log- picks mode.
    if (isSidebarSurface) switchTab('draft');
});
