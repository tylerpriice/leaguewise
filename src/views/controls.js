/**
 * The settings-bar and filter chrome: the timeframe controls, the Teams filter, the nickname sheet
 * and the tab availability rules that follow the league's season state. The timeframe is held in
 * AppState, and every change re-renders each surface that reads it.
 *
 * @module controls
 */
/**
 * One pill in the timeframe popover. The group says which row it belongs to; at most one of the
 * optional fields below names its kind.
 * @typedef {Object} TimeframeOption
 * @property {string} value The timeframe value the pill selects.
 * @property {string} [text] The label on the pill.
 * @property {string} [title] The hover text.
 * @property {'span'|'matchup'|'recent'} [group] The row the pill sits in.
 * @property {boolean} [disabled] Drawn greyed and not clickable.
 * @property {number} [window] The lookback size, for a window pill.
 * @property {number} [matchupAt] The matchup number, for the stepper caption.
 * @property {number} [step] -1 or 1, for a stepper arrow.
 * @property {boolean} [matchupAll] True for the pill that clears matchup, window and forward lens.
 * @property {'next'|'rest'} [aheadKey] Set on the two forward pills.
 * @property {string} [detail] The caption's second line.
 */
import { AppState } from '../data/state.js';
import { seasonState, isPreseason, draftLookBackOpen, SEASON_STATE } from '../data/season-state.js';
import { axisUnit, parseTimeframe, timeframeValueFor, matchupRangeFor, matchupStateOf, timeframeWindowSizes, matchupDateLabel, dateRangeLabel, displayTeamName, teamNameTitle, escapeHtml, renderActiveLeagueView } from './utils.js';
import { nicknamesKey, writeNicknames, currentProSchedule } from '../data/api.js';
import { datesByScoringPeriod } from '../engines/probables.js';
import { renderLeftColumn, renderRightColumn, renderHeatmapBand } from './graphs.js';
import { renderPlayerLeaderboard, refreshOpenPlayerDetail, rotoWindowsAvailable, rotoWindowMaxWeek, aheadReasons, ensureProScheduleData, boardBasis, ensureBoardBasis, matchupPeriodMap, periodsOfMatchup } from './players.js';
import { renderMyTeamTab } from './myteam.js';

/**
 * Re-renders every surface that reads the shared timeframe: the Team Metrics graphs, the Player
 * Metrics leaderboard and drill-down, and My Team. Each refreshes when it has data loaded,
 * whichever tab is active, so switching tabs never shows a stale window.
 * @returns {void}
 */
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
    // My Team windows with the same pills. Its roster lines, ranks and standing all read the current timeframe, so it re-renders here rather than waiting for a tab switch.
    if (AppState.apiData) renderMyTeamTab();
}


// Collapses the sport, league, year and fetch fields behind the gear button once data has loaded, since they are one-time setup. The first collapse plays a short jump on the gear to show where the fields went, and a slow interval replays it only while they stay collapsed.
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

/**
 * Collapses the sport, league, year and fetch fields behind the gear button and plays the gear's
 * jump. A slow interval replays the jump while the fields stay collapsed.
 * @returns {void}
 */
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

// Asks for the pro schedule once per league and rebuilds the pill row when it settles, because two of the ahead reasons need the schedule and it arrives after the first draw. The request is gated per league so the rebuild cannot trigger itself.
let aheadScheduleKey = null;
function regateAheadPillsWhenScheduleLands() {
    const data = AppState.apiData;
    const key = data ? `${data.id}|${data.seasonId}` : null;
    if (!key || aheadScheduleKey === key) return;
    aheadScheduleKey = key;
    ensureProScheduleData().then(() => {
        // The league may have been switched while the fetch was in flight; the key says so.
        const now = AppState.apiData;
        if (now && `${now.id}|${now.seasonId}` === key) rebuildTimeframeOptions();
    }).catch(() => {});
}

// The stepper caption's second line: the matchup's own dates and whether it is live or final. Either half may be absent. The days come from the schedule's own periods, so a matchup that has not scored its last days is dated by the days it has.
function matchupCaptionDetail(matchup) {
    const map = matchupPeriodMap();
    const periods = map ? periodsOfMatchup(map, matchup) : [];
    const schedule = currentProSchedule();
    // The games themselves are read when present and the period map is only the fallback. A football period is a week and the map holds one date for it, so a Thursday to Monday week would read as its first day alone.
    const proTeams = (schedule && schedule.settings && schedule.settings.proTeams) || [];
    const wanted = new Set(periods.map(Number));
    const stamps = [];
    proTeams.forEach(team => Object.entries((team && team.proGamesByScoringPeriod) || {}).forEach(([period, list]) => {
        if (!wanted.has(Number(period))) return;
        (list || []).forEach(g => { if (g && g.startTimeTBD !== true) stamps.push(Number(g.date)); });
    }));
    const when = stamps.length ? dateRangeLabel(stamps)
        : (schedule ? matchupDateLabel(periods, datesByScoringPeriod(schedule)) : null);
    const state = matchupStateOf(matchup, AppState.maxCompletedWeek, AppState.currentMatchup);
    const word = state === 'live' ? 'live' : state === 'final' ? 'final' : null;
    return [when, word].filter(Boolean).join(' · ');
}

/**
 * Rebuilds the timeframe pill row from the league's span lengths and schedule: the season spans,
 * the matchup stepper, the lookback windows and the two forward pills. A roto league keeps the
 * full season alone until its windows are built by syncRotoTimeframePills.
 * @param {boolean} [forceDefault] True on a genuine new league or season fetch, which resets the
 *   selection to the default instead of carrying it over.
 * @returns {void}
 */
export function rebuildTimeframeOptions(forceDefault = false) {
    regateAheadPillsWhenScheduleLands();
    // Roto has no matchup periods and ESPN serves one cumulative standing, so at load the only honest view is the full season. Windows are added later, once, when the started-day harvest lands, so the row never appears and relabels while it streams in.
    const toggleEl = document.getElementById('timeframe-toggle');
    if (AppState.isRotoLeague) {
        // Only a genuine new league tears the row down. This branch runs on every call, including from a pill click, so tearing down unconditionally would reset a chosen window at once and hide the row.
        if (!forceDefault) {
            // The H2H path highlights the new pill as a side effect of rebuilding the row. Returning early skips that, so roto moves the highlight itself, or the window would apply with every pill unselected.
            if (toggleEl) setActiveTimeframeChip(toggleEl, AppState.timeframe);
            return;
        }
        AppState.timeframe = 'all';
        rotoPillsShown = false;
        // The popover already starts closed, so no inline display style is set. An empty row is a harmless empty panel on a click that lands before the harvest, whereas a leftover inline style would override the hidden attribute and show nothing.
        if (toggleEl) toggleEl.innerHTML = '';
        return;
    }

    const maxWk = AppState.maxCompletedWeek;
    const regWks = AppState.regSeasonWeeks;
    const hasPlayoffs = maxWk > regWks;

    // Span labels are kept short so the row has room for the unit word on every lookback window. Every window counts matchups, not calendar weeks, since a playoff matchup can span several. The full wording stays available as a hover title.
    const options = [];
    // Full Season only means something different from Regular Season once playoffs have started. Before that they would be identical, so it is skipped.
    if (hasPlayoffs) options.push({ value: 'all', text: 'Full Season', title: 'Regular Season + Playoffs', group: 'span' });
    options.push({ value: 'reg', text: 'Regular Season', group: 'span' });

    // Playoffs sits directly after Regular Season (before the recent-window options), so the pill row reads Full Season -> Regular Season -> Playoffs -> This Matchup -> Last N.
    if (hasPlayoffs) options.push({ value: 'p_all', text: 'Playoffs', group: 'span' });

    // Lookback windows have fixed sizes rather than a percentage of the season. The group caption carries the unit, so no pill repeats it. A window applies only when its span is longer than it, and one that does not fit is drawn disabled rather than removed, because removing it moves every other pill sideways.
    const spanLength = (span) => {
        if (span === 'reg') return Math.min(maxWk, regWks);
        if (span === 'p_all') return Math.max(0, maxWk - regWks);
        return maxWk;
    };
    const activeSpan = parseTimeframe(AppState.timeframe).span;
    const spanValues = options.map(o => o.value);
    const span = spanValues.includes(activeSpan) ? activeSpan : (hasPlayoffs ? 'all' : 'reg');
    const unit = axisUnit();
    // The two forward pills, Next and Rest of season, close the same segmented group so it reads as one axis from past to future. They do not compose with the span: they drive the separate ahead field and are tagged with aheadKey. They are disabled by aheadReasons, the same check the leaderboard reads, so a pill never claims a window the board would refuse to draw.
    const ahead = aheadReasons();
    // The matchup row is a stepper over the span's own started matchups, and the one it stops on is the timeframe. There is no separate Current pill, since it was the one-wide window and the stepper on the live matchup shows the same view. An older stored value still parses and resolves.
    const range = matchupRangeFor(span, maxWk, regWks, AppState.currentMatchup);
    const picked = parseTimeframe(AppState.timeframe).matchup;
    if (range.last) {
        const at = Math.min(Math.max(picked || range.last, range.first), range.last);
        // A matchup carried into a span that does not hold it is rewritten here, not only clamped for drawing, so the stored value never points outside the span.
        if (picked && picked !== at) AppState.timeframe = timeframeValueFor(span, { matchup: at });
        options.push({
            value: timeframeValueFor(span, { matchup: at - 1 }), group: 'matchup', step: -1,
            text: '‹', disabled: at <= range.first,
            title: `The ${unit.long.toLowerCase()} before this one`
        });
        options.push({
            value: timeframeValueFor(span, { matchup: at }), group: 'matchup', matchupAt: at,
            text: `${unit.long} ${at}`, detail: matchupCaptionDetail(at),
            title: `Only ${unit.long.toLowerCase()} ${at}`
        });
        options.push({
            value: timeframeValueFor(span, { matchup: at + 1 }), group: 'matchup', step: 1,
            text: '›', disabled: at >= range.last,
            title: at >= range.last
                ? `${unit.long} ${at + 1} has not started`
                : `The ${unit.long.toLowerCase()} after this one`
        });
    }

    // A lookback is offered only once the season is longer than it, and the sizes come from the season's own length rather than the sport. All leads this row because it answers the same question as the windows, how much of the span to read, and it is the one pill that clears the matchup, the window and the forward lens.
    options.push({
        value: span, group: 'recent', matchupAll: true, text: 'All',
        title: `Every ${unit.long.toLowerCase()} in this span`
    });

    // Every size is drawn, greyed when it does not fit, because a pill that disappears moves every other pill sideways.
    timeframeWindowSizes(regWks).forEach(n => {
        const fits = spanLength(span) > n;
        options.push({
            value: `${span}+last${n}`, group: 'recent', window: n, disabled: !fits,
            text: `Last ${n}`,
            title: !fits
                ? `Only ${spanLength(span)} ${(spanLength(span) === 1 ? unit.long : unit.plural).toLowerCase()} in this span`
                : `The last ${n} completed ${unit.plural.toLowerCase()}`
        });
    });
    // The two forward pills close the row, so it reads from past to future.
    options.push({
        value: '__ahead_next', group: 'recent', aheadKey: 'next', disabled: !!ahead.next,
        text: 'Next', title: ahead.next || 'Your next matchup, projected'
    });
    options.push({
        value: '__ahead_rest', group: 'recent', aheadKey: 'rest', disabled: !!ahead.rest,
        text: 'Rest of season', title: ahead.rest || 'The rest of the season from today, projected'
    });

    // Before the first game every surface reads the same projected line whichever pill is lit, so a live row would offer a choice that changes nothing. The row is hidden outright for a preseason league by setTimeframeVisible, so nothing is greyed here.
    const currentVal = forceDefault ? null : AppState.timeframe;
    const fallback = hasPlayoffs ? 'all' : 'reg';
    // A window that the new span cannot offer costs the window, not the span. Switching to a short playoff bracket while holding a lookback used to drop both and land on Full Season.
    const spanOnly = currentVal ? parseTimeframe(currentVal).span : null;
    const live = (val) => options.some(o => o.value === val && !o.disabled);
    AppState.timeframe = live(currentVal) ? currentVal : (live(spanOnly) ? spanOnly : fallback);

    renderTimeframeToggle(options);
    // Re-evaluated on every rebuild, not only on a tab click, so the selector returns as soon as the season leaves preseason. The preseason check in setTimeframeVisible wins regardless of what is passed. The active tab is read off the DOM because this function has no other way to know it.
    const historyActive = document.getElementById('tab-btn-history')?.classList.contains('active');
    const draftActive = document.getElementById('tab-btn-draft')?.classList.contains('active');
    setTimeframeVisible(!historyActive && !draftActive);
}

/**
 * Dims and disables the My Team tab before the draft, with a title that says why. The tab is
 * dimmed rather than removed so it still reads as part of the app, and disabled so it cannot be
 * entered until a draft has happened. Runs on every rebuild, so the state lifts when the draft
 * ends.
 * @returns {void}
 */
export function refreshMyTeamTabAvailability() {
    const btn = document.getElementById('tab-btn-myteam');
    if (!btn) return;
    const preDraft = seasonState(AppState.apiData) === SEASON_STATE.PRE_DRAFT;
    btn.classList.toggle('tab-button-dim', preDraft);
    btn.disabled = preDraft;
    btn.title = preDraft ? 'Nothing to show until the draft is held' : '';
}

/**
 * Shows or hides the Draft tab. A drafted league always keeps it, because there is a durable board
 * to show: the results grid when no basis was saved, the ranked sheet when one was. An undrafted
 * league keeps it only while a saved basis exists and the look-back window is open. The saved
 * basis loads asynchronously, so this function passes itself as the callback and re-runs when the
 * basis settles.
 * @returns {void}
 */
export function refreshDraftTabAvailability() {
    const btn = document.getElementById('tab-btn-draft');
    if (!btn) return;
    ensureBoardBasis(refreshDraftTabAvailability);
    const drafted = AppState.apiData?.draftDetail?.drafted === true;
    const lives = drafted || (boardBasis().state !== 'none' && draftLookBackOpen(AppState.apiData));
    btn.style.display = lives ? '' : 'none';
}

/**
 * Shows or hides the timeframe control for the active tab. League History and the Draft tab have
 * no timeframe to narrow, and a preseason league has no matchups, so the control is hidden outright
 * there rather than disabled. The preseason check lives here, so it wins regardless of what a
 * caller passes.
 * @param {boolean} visible Whether the active tab wants the control.
 * @returns {void}
 */
export function setTimeframeVisible(visible) {
    // The class sits on the wrapper so the chip hides as well as the panel it opens. The popover is force-closed at the same time, so a tab switch while it is open cannot leave it open and invisible.
    const wrap = document.querySelector('.timeframe-menu');
    if (!wrap) return;
    const hide = !visible || isPreseason(seasonState(AppState.apiData));
    wrap.classList.toggle('timeframe-hidden', hide);
    if (hide) closeTimeframePopover();
}

function renderTimeframeToggle(options) {
    const toggle = document.getElementById('timeframe-toggle');
    toggle.innerHTML = '';

    // Two segmented groups rather than one long run: the left picks which part of the season and the right picks how recent a stretch. They are different questions, and merging them made the row read as seven equal choices. The unit caption follows the league's own timeline unit. The row lives in the scope chip's popover, with a label beside each segment.
    const seg = (name) => {
        const el = document.createElement('div');
        el.className = `timeframe-seg timeframe-seg-${name}`;
        return el;
    };
    const spanLabel = document.createElement('span');
    spanLabel.className = 'timeframe-pop-label';
    spanLabel.textContent = 'Span';
    toggle.appendChild(spanLabel);
    const groups = { span: seg('span'), matchup: seg('matchup'), recent: seg('recent') };
    toggle.appendChild(groups.span);
    // Three rows, each labelled by the question it answers. The middle row carries the unit's own name and picks one matchup. A league with no started matchup gets no middle row, so the popover keeps one shape.
    const rowLabel = (text) => {
        const el = document.createElement('span');
        el.className = 'timeframe-pop-label';
        el.textContent = text;
        return el;
    };
    if (options.some(o => o.group === 'matchup')) {
        toggle.appendChild(rowLabel(axisUnit().long));
        toggle.appendChild(groups.matchup);
    }
    toggle.appendChild(rowLabel('Window'));
    toggle.appendChild(groups.recent);

    options.forEach(opt => {
        const btn = document.createElement('button');
        btn.type = 'button';
        // Each segment shows its own half of the answer. The ahead pills answer a third, independent question, so their lit state is read off AppState.ahead and not the timeframe.
        const cur = parseTimeframe(AppState.timeframe);
        // Exactly one thing is lit across the Matchup and Window rows. All is lit only when no matchup, window or forward lens is set, which is what all of the span means. The arrows are moves, not a state, so they never light.
        const isActive = opt.aheadKey ? AppState.ahead === opt.aheadKey
            : opt.matchupAll ? (!cur.matchup && !cur.window && !AppState.ahead)
            : opt.matchupAt ? (cur.matchup === opt.matchupAt && !AppState.ahead)
            : opt.step ? false
            : (opt.group === 'recent' ? (cur.window === opt.window && !cur.matchup && !AppState.ahead)
                // A specific matchup unlights the span so the matchup alone is lit. A recent window still composes with the span and both stay lit.
                : (cur.span === opt.value && !cur.matchup));
        btn.className = 'timeframe-chip' + (isActive ? ' active' : '') + (opt.disabled ? ' disabled' : '')
            + (opt.step ? ' timeframe-step' : '') + (opt.matchupAt ? ' timeframe-stepper' : '');
        btn.disabled = !!opt.disabled;
        btn.textContent = opt.text;
        // The stepper's second line is the matchup's dates and whether it is live or final. A league with no pro schedule fetched has no dates, and the caption is then the number alone.
        if (opt.detail) {
            const detail = document.createElement('span');
            detail.className = 'timeframe-step-detail';
            detail.textContent = opt.detail;
            btn.appendChild(detail);
        }
        // The full, unabbreviated wording shows on hover; see the label comment above the options array in rebuildTimeframeOptions.
        btn.title = opt.title || opt.text;
        btn.dataset.value = opt.value;
        // What the CHIP says for this pill, when it is not the pill's own text alone: the stepper's caption carries a second line, and the chip wants the matchup's name alone.
        if (opt.matchupAt) btn.dataset.chipText = opt.text;
        // All says nothing the span has not said, so the chip stays at the span's name rather than growing an All suffix.
        if (opt.matchupAll) btn.dataset.chipQuiet = '1';
        (groups[opt.group] || groups.span).appendChild(btn);
        if (opt.disabled) return;
        btn.addEventListener('click', () => {
            // A pill click is a choice, so the popover closes on it whether or not the click changed anything, as a native select does when its own value is picked again.
            closeTimeframePopover();
            // An ahead pill toggles AppState.ahead directly and takes its own branch before the span and window logic. Clicking the active one clears it, like the window pills.
            if (opt.aheadKey) {
                const turningOn = AppState.ahead !== opt.aheadKey;
                AppState.ahead = turningOn ? opt.aheadKey : null;
                // A forward lens answers for the whole span ahead, so turning it on drops a picked matchup and a lookback window. The row holds one answer.
                if (turningOn) {
                    const held = parseTimeframe(AppState.timeframe);
                    if (held.matchup || held.window) AppState.timeframe = held.span;
                }
                rebuildTimeframeOptions();
                handleTimeframeChange();
                return;
            }
            // A window pill toggles. Clicking the active one drops back to the whole span, which is how "the whole regular season" stays reachable without spending a pill on saying so. A span pill carries the current window across, so switching Regular Season to Playoffs keeps you on "last 4" rather than silently widening the view.
            const cur = parseTimeframe(AppState.timeframe);
            const aheadBefore = AppState.ahead;
            let next;
            if (AppState.isRotoLeague) {
                // Roto's pills do not compose. It has one official standing and a set of lookback windows over it, so its row is a plain single select and its options carry no group. Carrying the current window across would produce a value no pill matches.
                next = opt.value;
            } else if (opt.matchupAll) {
                // All is the clean slate: no matchup, no window and no forward lens. It sits in the Window row, where every pill answers how much of the span to read.
                AppState.ahead = null;
                next = cur.span;
            } else if (opt.group === 'matchup') {
                // An arrow or the caption names a matchup, which clears the window and the forward lens, so the row never shows two lit answers.
                AppState.ahead = null;
                next = opt.value;
            } else if (opt.group === 'recent') {
                // A window clears a picked matchup, the same exchange the other way round, and the forward lens too.
                AppState.ahead = null;
                next = (cur.window === opt.window && !cur.matchup) ? cur.span : `${cur.span}+last${opt.window}`;
            } else {
                // A span carries the window across but not a picked matchup. The matchup unlit the span, so pressing a span returns to the full span, whichever span it is.
                next = cur.matchup ? opt.value
                    : cur.window ? `${opt.value}+last${cur.window}` : opt.value;
            }
            // A forward lens counts as a change. Clicking All while the value is already the bare span still turns Next off, so returning early on the unchanged value would leave the pill lit over a board that no longer reads it.
            if (AppState.timeframe === next && AppState.ahead === aheadBefore) return;
            AppState.timeframe = next;
            rebuildTimeframeOptions();
            handleTimeframeChange();
        });
    });
    renderTimeframeChipText();
}

// The scope chip's words, read off whichever pills are lit now, so one function serves a full rebuild and a roto click that only moved the active class. When an ahead pill and a window are both lit, the ahead pill wins the sentence as the more deliberate choice.
function renderTimeframeChipText() {
    const chipText = document.getElementById('timeframe-scope-text');
    const toggle = document.getElementById('timeframe-toggle');
    if (!chipText || !toggle) return;
    const spanBtn = toggle.querySelector('.timeframe-seg-span .timeframe-chip.active');
    const recentBtns = [...toggle.querySelectorAll('.timeframe-seg-recent .timeframe-chip.active:not([data-chip-quiet])')];
    const recentBtn = recentBtns.find(b => b.dataset.value?.startsWith('__ahead')) || recentBtns[0];
    // A picked matchup is the second half of the sentence, and an ahead pill still wins it. The chip text attribute is read rather than the button's own text, since the stepper's caption carries a second line.
    const matchupBtn = toggle.querySelector('.timeframe-seg-matchup .timeframe-chip.active[data-chip-text]');
    // The span's words come from the chip for the span in the value, lit or not. A picked matchup unlights it, and the sentence still opens with the span the matchup is in.
    const heldSpan = parseTimeframe(AppState.timeframe).span;
    const heldSpanBtn = toggle.querySelector(`.timeframe-seg-span .timeframe-chip[data-value="${heldSpan}"]`);
    const spanText = spanBtn ? spanBtn.textContent : (heldSpanBtn ? heldSpanBtn.textContent : 'Full Season');
    const tail = recentBtn ? recentBtn.textContent : (matchupBtn ? matchupBtn.dataset.chipText : null);
    chipText.textContent = tail ? `${spanText} · ${tail}` : spanText;
}

/**
 * Closes the timeframe popover and updates aria-expanded to match. A pill choice, an outside click
 * and Escape all need the same close.
 * @returns {void}
 */
export function closeTimeframePopover() {
    const popover = document.getElementById('timeframe-toggle');
    const btn = document.getElementById('timeframe-scope-btn');
    if (popover) popover.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
}

// Roto timeframe pills are decided once, when the started-day harvest lands. Roto windows are only honest on started-day data, which arrives asynchronously, so the row starts hidden and is shown the first time that tier is ready. The shown flag makes later calls no-ops, so the pills never flicker and a chosen window is never torn down.
let rotoPillsShown = false;
/**
 * Builds the roto league's timeframe pills once, when the started-day harvest has landed. Does
 * nothing for other league types, before the harvest is ready or after the first build.
 * @returns {void}
 */
export function syncRotoTimeframePills() {
    if (!AppState.isRotoLeague || rotoPillsShown) return;
    const sport = AppState.loadedSport;
    if (!rotoWindowsAvailable(sport)) return; // still on a fallback tier or harvest not done, so stay hidden

    const toggleEl = document.getElementById('timeframe-toggle');
    if (!toggleEl) return;

    // Full Season stays the default and shows the official standings verbatim. The lookback pills re-score the categories over that window's started-day components. Windows are day buckets grouped to weeks and labelled by week, and one is offered only when the season is longer than it.
    const maxWeek = rotoWindowMaxWeek(sport);
    // Grouped like every other format's row: roto's one official standing is the span and its lookbacks are the recent windows. Without a group every pill fell into the span segment and the caption trailed off the end of the row.
    const options = [{ value: 'all', text: 'Full Season', title: "ESPN's official season standings", group: 'span' }];
    // Same past-to-future axis as the H2H row. Next is always disabled for roto, and Rest of season is live whenever a pro schedule is in hand, since it needs no matchup, only today through the final period.
    [12, 8, 4].forEach(n => {
        if (maxWeek > n) options.push({ value: `last${n}`, text: `Last ${n} Weeks`, group: 'recent', window: n });
    });
    // Current is offered only once the season is longer than a week, on the same rule as the lookbacks. It is the same last1 window the other formats use, in the same place in the row. It also makes the day-level roto surfaces reachable, since their day-drawing branches run only for a one-week window.
    if (maxWeek > 1) options.push({ value: 'last1', text: 'Current', title: 'The current week, day by day', group: 'recent', window: 1 });
    // Roto gets both ahead pills. Next is always disabled with a structural reason, and Rest of season follows the ordinary schedule check. A pill that says why beats a missing one, so the row is not hidden for a season too short for a lookback.
    const ahead = aheadReasons();
    options.push({
        value: '__ahead_next', group: 'recent', aheadKey: 'next', disabled: !!ahead.next,
        text: 'Next', title: ahead.next || 'Your next matchup, projected'
    });
    options.push({
        value: '__ahead_rest', group: 'recent', aheadKey: 'rest', disabled: !!ahead.rest,
        text: 'Rest of season', title: ahead.rest || 'The rest of the season from today, projected'
    });

    renderTimeframeToggle(options); // AppState.timeframe is still 'all', so Full Season starts active
    rotoPillsShown = true;
}

// A click only ever changes which one button is highlighted, so this moves the active class instead of tearing down and recreating every button and listener the way a full rebuild does.
function setActiveTimeframeChip(toggle, value) {
    toggle.querySelectorAll('.timeframe-chip').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === value);
    });
    renderTimeframeChipText();
}

/**
 * Builds the Teams filter: one chip per team with its swatch and the league's own abbreviation,
 * then fits the strip. The abbreviation is ESPN's own field and never a slice of the display name,
 * since two teams can share a prefix.
 * @returns {void}
 */
export function buildTeamFilterChips() {
    const legendContainer = document.getElementById('team-legend');
    legendContainer.innerHTML = '';

    AppState.teamStats.forEach((t) => {
        const color = AppState.teamColorMap[t.id];
        const label = document.createElement('label');
        label.className = 'df-team-chip';
        label.dataset.teamId = String(t.id);
        label.title = teamNameTitle(t) || displayTeamName(t);

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = AppState.visibleTeams.has(t.id);

        checkbox.addEventListener('change', (e) => {
            if (e.target.checked) AppState.visibleTeams.add(t.id);
            else AppState.visibleTeams.delete(t.id);
            fitTeamFilterChips();
            renderLeftColumn();
            renderRightColumn();
            renderHeatmapBand();
        });

        const swatch = document.createElement('span');
        swatch.className = 'df-team-chip-swatch';
        swatch.style.backgroundColor = color;

        // The same abbreviation-or-fallback rule the bar rows apply: a real ESPN abbreviation stands as it is, and only a league with none falls back to the possibly nicknamed full name.
        const name = document.createElement('span');
        name.textContent = t.abbrev || displayTeamName(t);

        label.appendChild(checkbox);
        label.appendChild(swatch);
        label.appendChild(name);
        legendContainer.appendChild(label);
    });

    fitTeamFilterChips();
    wireTeamPopoverOnce();
    observeTeamFilterFit();
}

// Measured against the row's real width after layout, never a team-count breakpoint, since what varies is the abbreviations' width and the room the Trend Lines group takes. Inline is tried first on every call, so a league that gains room is not stuck collapsed.
function fitTeamFilterChips() {
    const inline = document.getElementById('df-team-inline');
    const summary = document.getElementById('df-team-summary');
    const popover = document.getElementById('df-team-popover');
    const chips = document.getElementById('team-legend');
    if (!inline || !summary || !popover || !chips) return;

    // In the tab's own bar the teams are always the one button, with hidden teams standing as struck-through chips beside it, so what is off reads without opening anything. The measured fit below serves the two pop-out overlays.
    const inBar = !!inline.closest('.data-filters-bar');
    const total = AppState.teamStats.length;
    const shown = AppState.teamStats.filter(t => AppState.visibleTeams.has(t.id)).length;
    if (inBar) {
        inline.hidden = true;
        popover.appendChild(chips);
        summary.hidden = false;
        summary.textContent = `Teams ${shown} of ${total}`;
        summary.classList.toggle('is-filtered', shown < total);
        renderHiddenTeamChips();
        return;
    }
    summary.classList.remove('is-filtered');

    inline.hidden = false;
    inline.appendChild(chips);
    summary.hidden = true;
    popover.hidden = true;

    // The chip list is inline-flex, not flex. A block-level flex container stretches to its parent's width, so scrollWidth would report that box width and the check would pass unconditionally. Inline-flex shrink-wraps to content, so scrollWidth is the strip's own one-line width.
    const fits = chips.scrollWidth <= inline.clientWidth + 1;
    if (!fits) {
        inline.hidden = true;
        popover.appendChild(chips);
        summary.hidden = false;
        summary.textContent = `Teams (${AppState.teamStats.length})`;
    }
}

/**
 * Re-runs the fit after the pop-out controllers move the Teams group between the bar and an
 * overlay. In the bar it is always the one button; in an overlay it is the measured chips-or-button
 * fit.
 * @returns {void}
 */
export function refitTeamFilters() {
    fitTeamFilterChips();
}

// The hidden teams stand on the bar's line as struck-through chips. A press puts the team back through its checkbox in the popover's list, so AppState.visibleTeams changes in one place. Past four the rest fold into a count, never a second row.
const HIDDEN_CHIPS_SHOWN = 4;
function renderHiddenTeamChips() {
    const host = document.getElementById('df-hidden-chips');
    if (!host) return;
    host.innerHTML = '';
    const hidden = AppState.teamStats.filter(t => !AppState.visibleTeams.has(t.id));
    hidden.slice(0, HIDDEN_CHIPS_SHOWN).forEach(t => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'df-hidden-chip';
        chip.title = `Show ${teamNameTitle(t) || displayTeamName(t)}`;
        const swatch = document.createElement('span');
        swatch.className = 'df-team-chip-swatch';
        swatch.style.backgroundColor = AppState.teamColorMap[t.id];
        const name = document.createElement('span');
        name.textContent = t.abbrev || displayTeamName(t);
        const x = document.createElement('span');
        x.className = 'df-hidden-chip-x';
        x.textContent = '\u2715';
        chip.append(swatch, name, x);
        chip.addEventListener('click', () => {
            document.querySelector(`#team-legend .df-team-chip[data-team-id="${t.id}"] input`)?.click();
        });
        host.appendChild(chip);
    });
    if (hidden.length > HIDDEN_CHIPS_SHOWN) {
        const more = document.createElement('span');
        more.className = 'df-hidden-more';
        more.textContent = `+${hidden.length - HIDDEN_CHIPS_SHOWN}`;
        host.appendChild(more);
    }
}

// The popover uses the same click, outside-click and Escape pattern as the legend and timeframe popovers. It is wired once, since the chips are rebuilt per league load and a second document listener per reload would fire the close twice.
let teamPopoverWired = false;
function wireTeamPopoverOnce() {
    if (teamPopoverWired) return;
    const btn = document.getElementById('df-team-summary');
    const pop = document.getElementById('df-team-popover');
    if (!btn || !pop) return;
    teamPopoverWired = true;
    const setOpen = (open) => {
        pop.hidden = !open;
        btn.setAttribute('aria-expanded', String(open));
    };
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setOpen(pop.hidden);
    });
    document.addEventListener('click', (e) => {
        if (!pop.hidden && !pop.contains(e.target) && e.target !== btn) setOpen(false);
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !pop.hidden) setOpen(false);
    });
}

// Observing the bar's own container is safe because the fit only moves the chip list between two fixed-size slots and never changes the width being watched, so re-fitting on every notification cannot feed back. It is attached once, since the bar is never torn down.
let teamFilterFitObserver = null;
function observeTeamFilterFit() {
    if (teamFilterFitObserver || typeof ResizeObserver === 'undefined') return;
    const bar = document.getElementById('control-panel');
    if (!bar) return;
    let lastWidth = 0;
    teamFilterFitObserver = new ResizeObserver(() => {
        const w = bar.clientWidth;
        if (!w || w === lastWidth) return;
        lastWidth = w;
        fitTeamFilterChips();
    });
    teamFilterFitObserver.observe(bar);
}

// The Nicknames sheet in the settings drawer: one row per team and a footer that clears every nickname for the league. It saves as the reader types, debounced per input with a module-scoped timer keyed by team id, since more than one row can be mid-edit at once.
const nicknameSaveTimers = new Map();

function saveNicknameDebounced(teamId, value) {
    clearTimeout(nicknameSaveTimers.get(teamId));
    nicknameSaveTimers.set(teamId, setTimeout(async () => {
        nicknameSaveTimers.delete(teamId);
        const key = nicknamesKey(AppState.loadedSport, AppState.apiData.id);
        const stored = Object.fromEntries(AppState.nicknames);
        if (value) stored[teamId] = value; else delete stored[teamId];
        const ok = await writeNicknames(key, stored);
        if (!ok) return;   // storage failed; AppState still holds the edit, unsaved
        AppState.nicknames = new Map(Object.entries(stored));
        renderActiveLeagueView();
    }, 400));
}

/**
 * Builds the Nicknames sheet in the settings drawer: one row per team with an input and a clear
 * button, and a footer that clears every nickname for the league. Hides the group before data
 * loads.
 * @returns {void}
 */
export function buildNicknamesSheet() {
    const group = document.getElementById('nicknames-group');
    const list = document.getElementById('nicknames-list');
    const clearAllBtn = document.getElementById('nicknames-clear-all');
    if (!group || !list || !clearAllBtn) return;
    if (!AppState.apiData || !AppState.teamStats.length) {
        group.style.display = 'none';
        return;
    }
    group.style.display = '';
    list.innerHTML = '';

    AppState.teamStats.forEach((t) => {
        // Two lines per row: the name gets the row's full width and wraps rather than truncating, and the input gets its own full-width line with the clear button inside its right edge. At the settings rail's width one line left every name cut off and the clear button invisible.
        const row = document.createElement('div');
        row.className = 'nicknames-row';

        const head = document.createElement('div');
        head.className = 'nicknames-head';

        const dot = document.createElement('span');
        dot.className = 'nicknames-dot';
        dot.style.backgroundColor = AppState.teamColorMap[t.id];

        const espnName = document.createElement('span');
        espnName.className = 'nicknames-espn';
        espnName.textContent = t.name;

        head.appendChild(dot);
        head.appendChild(espnName);

        const inputWrap = document.createElement('div');
        inputWrap.className = 'nicknames-input-wrap';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'nicknames-input';
        input.placeholder = 'Nickname';
        input.value = AppState.nicknames.get(String(t.id)) || '';

        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'nicknames-clear';
        clearBtn.textContent = '×';
        clearBtn.setAttribute('aria-label', `Clear nickname for ${t.name}`);
        clearBtn.hidden = !input.value;

        input.addEventListener('input', () => {
            clearBtn.hidden = !input.value;
            saveNicknameDebounced(String(t.id), input.value.trim());
        });
        clearBtn.addEventListener('click', () => {
            input.value = '';
            clearBtn.hidden = true;
            saveNicknameDebounced(String(t.id), '');
        });

        inputWrap.appendChild(input);
        inputWrap.appendChild(clearBtn);

        row.appendChild(head);
        row.appendChild(inputWrap);
        list.appendChild(row);
    });

    clearAllBtn.onclick = async () => {
        const key = nicknamesKey(AppState.loadedSport, AppState.apiData.id);
        const ok = await writeNicknames(key, {});
        if (!ok) return;
        AppState.nicknames = new Map();
        buildNicknamesSheet();
        renderActiveLeagueView();
    };
}
