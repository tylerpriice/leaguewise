/**
 * The content script for ESPN's draft room page. It runs in the extension's isolated world, only
 * on the draft room's own address and only at the start of that page's load.
 *
 * It injects room-hook.js into the page, reads the frames that script mirrors, parses them through
 * room-feed.js, and writes a snapshot of the draft so far to extension storage for the extension's
 * pages to read. It can also read the room's own draft board off the page, to recover picks no
 * frame delivered. On a Draft press from the extension it finds the player in ESPN's own search
 * and presses ESPN's own button. It never opens a connection and never sends a frame of its own.
 *
 * The room's sign-in line and the reader's ESPN id are never stored: a frame that carries either
 * parses to nothing, and unparsed frames are kept only as shapes and counts.
 *
 * A classic script, not a module. It reaches room-feed.js through a dynamic import.
 *
 * Tests: tests/room-reader.test.html
 * @file
 */
(function () {
    // The two halves of a cell's round and pick text, and the two numbers in its inline grid-area style. The inline attribute is read, not a computed style, which would cost a layout for every cell. A board placed by class reads null for the row.
    const GRID_AREA = /grid-area:\s*(\d+)\s*\/\s*(\d+)/;

    function textOf(root, selector) {
        const el = root.querySelector(selector);
        return el ? String(el.textContent || '').trim() : '';
    }

    function readBoardCells(root) {
        if (!root || typeof root.querySelectorAll !== 'function') return [];
        // Only a completed pick is read. A cell with no pick in it is left out, not guessed at from its contents.
        const cells = root.querySelectorAll('.draft-board-grid-pick-cell.completedPick');
        const out = [];
        cells.forEach(cell => {
            const rp = textOf(cell, '.roundPick').split('.');
            const area = GRID_AREA.exec(cell.getAttribute('style') || '');
            out.push({
                round: rp[0] === undefined || rp[0] === '' ? null : Number(rp[0]),
                pickInRound: rp[1] === undefined || rp[1] === '' ? null : Number(rp[1]),
                row: area ? Number(area[1]) : null,
                column: area ? Number(area[2]) : null,
                // The reader's own team, by ESPN's own class and not by any position in the grid.
                mine: cell.classList.contains('myTeam'),
                firstName: textOf(cell, '.playerFirstName'),
                lastName: textOf(cell, '.playerLastName'),
                proTeam: textOf(cell, '.playerProTeam'),
                position: textOf(cell, '.positionPill')
            });
        });
        return out;
    }

    // The grid's width, which turns a round and a pick number into an overall. It is taken from the header row, so a board read in the middle of a round still gives the right overalls.
    function readBoardColumns(root) {
        if (!root || typeof root.querySelectorAll !== 'function') return 0;
        return root.querySelectorAll('.draft-board-grid-header-cell').length;
    }

    // Whether this is the board already written. An unchanged board must write nothing. The signature is a 32-bit hash over each pick's overall and name, a cheap answer to whether anything changed.
    function boardSignature(picks) {
        let hash = 0x811c9dc5;
        (picks || []).forEach(pick => {
            const text = `${pick.overall}|${pick.name}|${pick.mine ? 1 : 0}`;
            for (let i = 0; i < text.length; i++) {
                hash ^= text.charCodeAt(i);
                hash = (hash * 0x01000193) >>> 0;
            }
        });
        return `${(picks || []).length}:${hash.toString(16)}`;
    }

    window.__leaguewiseRoomDom = { readBoardCells, readBoardColumns, boardSignature };
})();

(function () {
    if (location.pathname.indexOf('/draft') === -1) return;

    // Logged so that a content script that never ran can be told apart from one that ran and received no frame.
    console.log('Leaguewise: room reader active on', location.pathname);

    // room-feed.js is imported by a literal path, never a computed one, since the packaging tools follow a dynamic import by reading the string as written. A failed import is logged once per distinct failure and the promise is cleared, so the next frame tries again.
    let roomFeedPromise = null;
    function loadRoomFeed() {
        if (!roomFeedPromise) {
            roomFeedPromise = import(browser.runtime.getURL('src/data/room-feed.js')).catch(err => {
                console.error('Leaguewise: room-feed.js failed to load', err && err.message);
                roomFeedPromise = null;
                throw err;
            });
        }
        return roomFeedPromise;
    }

    // The room's own address names the league and the season. It is read once, since it cannot change within one page load.
    let roomUrlInfo = null;
    function roomUrl() {
        if (roomUrlInfo) return roomUrlInfo;
        try {
            const url = new URL(location.href);
            roomUrlInfo = {
                sport: url.pathname.split('/').filter(Boolean)[0] || null,
                leagueId: url.searchParams.get('leagueId') !== null ? Number(url.searchParams.get('leagueId')) : null,
                seasonId: url.searchParams.get('seasonId') !== null ? Number(url.searchParams.get('seasonId')) : null
            };
        } catch {
            roomUrlInfo = { sport: null, leagueId: null, seasonId: null };
        }
        return roomUrlInfo;
    }

    // Every fact this page load has seen, in arrival order. The reader's own team comes from the one frame that states it.
    const facts = [];
    let myTeamId = null;

    // Resuming what the last sitting knew. The facts live in page scope, so a reloaded tab or extension starts from nothing. The snapshot written before the restart is read back once and the picks rebuilt from it, but only when it is this league's and not stale. Only picks are rebuilt: the clock is a fact about a moment and arrives again on the next frame.
    let resumed = false;
    async function resumeFromSnapshot() {
        if (resumed) return;
        resumed = true;
        let stored = null;
        try {
            const bag = await browser.storage.local.get('roomState');
            stored = bag && bag.roomState;
        } catch { return; }
        if (!stored || !Array.isArray(stored.picks) || !stored.picks.length) return;
        if (facts.length) return;                       // this sitting already has its own
        const info = roomUrl();
        if (info.leagueId !== null && stored.leagueId !== null && stored.leagueId !== undefined
            && String(stored.leagueId) !== String(info.leagueId)) return;
        const { roomIsStale } = await loadRoomFeed();
        if (roomIsStale(stored)) return;
        stored.picks.forEach(pick => {
            if (!pick || pick.playerId === null || pick.playerId === undefined) return;
            facts.push({ kind: 'selected', teamId: pick.teamId ?? null, playerId: pick.playerId,
                         at: Number.isFinite(pick.at) ? pick.at : null });
        });
        if (Number.isFinite(stored.myTeamId)) myTeamId = stored.myTeamId;
        console.log('Leaguewise: resumed ' + facts.length + " picks from this room's own snapshot");
        writeSnapshot();
    }

    // The round and the pick stay null in this snapshot: turning a count of picks into them needs the league's team count, which this page does not have. The status follows the hook's open and close events, so a room that ends reads closed at once.
    let roomStatusOpen = true;

    // Which connections were seen: one entry per connection the hook saw opened, whether or not it delivered a frame, so no connection, an open and silent one, and frames arriving can be told apart. Entries are keyed by transport and endpoint, so a fallback to a second path is not hidden.
    const transports = new Map();
    // The room's own endpoint, adopted from the first frame that parses. Null until then, and a room that has not spoken cannot have ended.
    let roomEndpoint = null;

    // Restated here and not imported: room-feed.js arrives through an asynchronous import, and this decision has to be made at once inside a message listener that cannot wait. room-feed.js exports the same rule, and its suite states the expected answers.
    function classifyRoomEvent(known, msg) {
        if (!msg || typeof msg !== 'object') return 'foreign';
        if (known === null || known === undefined) return 'unproven';
        const from = typeof msg.endpoint === 'string' ? msg.endpoint : null;
        return from !== null && from === known ? 'room' : 'foreign';
    }

    function noteTransport(msg, kind, role) {
        const transport = typeof msg.transport === 'string' ? msg.transport : 'unknown';
        const endpoint = typeof msg.endpoint === 'string' ? msg.endpoint : null;
        const key = transport + '|' + (endpoint || '');
        let row = transports.get(key);
        if (!row) {
            row = { transport, endpoint, openedAt: null, firstFrameAt: null, frames: 0, event: null,
                    lastErrorAt: null, lastReadyState: null, isRoom: role === 'room' };
            transports.set(key, row);
            // One log line per connection opened. The endpoint is already masked by the hook, with no query and with ids replaced.
            if (kind === 'open') {
                // An open on another endpoint says so, so a console read during a draft does not look like two rooms.
                console.log('Leaguewise: room-hook saw ' + transport + ' open on '
                    + (endpoint || '(unparsed url)')
                    + (role === 'foreign' ? ' - not the room, ignored' : ''));
            }
        }
        if (kind === 'open' && row.openedAt === null) row.openedAt = msg.at ?? Date.now();
        if (role === 'room') row.isRoom = true;
        if (kind === 'frame') {
            row.frames += 1;
            if (row.firstFrameAt === null) row.firstFrameAt = msg.at ?? Date.now();
            if (typeof msg.event === 'string') row.event = msg.event;
        }
        if (kind === 'error') {
            row.lastErrorAt = msg.at ?? Date.now();
            row.lastReadyState = Number.isFinite(msg.readyState) ? msg.readyState : null;
        }
        return row;
    }

    // The first frames the parser could not read, kept for diagnosis under a small cap. Nothing reads them as facts. room-feed.js's bufferFrame decides what is kept: a frame that is not news is counted and dropped, and anything else is kept as its shape and its length, never its text.
    const UNKNOWN_FRAME_CAP = 8;
    let frameBuffer = { frames: [], notNews: {} };
    async function noteUnknownFrame(msg, data) {
        const { bufferFrame } = await loadRoomFeed();
        frameBuffer = bufferFrame(frameBuffer, {
            transport: typeof msg.transport === 'string' ? msg.transport : 'unknown',
            event: typeof msg.event === 'string' ? msg.event : null,
            at: msg.at ?? Date.now(),
            data
        }, { cap: UNKNOWN_FRAME_CAP });
    }

    // Declared before the function that writes the snapshot, which reads it. A let that has not yet run would throw.
    let lastBoard = null;

    async function writeSnapshot() {
        const { roomStatus, applyRoomFacts } = await loadRoomFeed();
        const status = roomStatus(facts, { now: Date.now() });
        const merged = applyRoomFacts(null, facts);
        const info = roomUrl();
        const snapshot = {
            leagueId: info.leagueId,
            seasonId: info.seasonId,
            sport: info.sport,
            status: roomStatusOpen ? 'open' : 'closed',
            at: Date.now(),
            myTeamId,
            onClock: status.onClock,
            msRemaining: status.msRemaining,
            picks: merged.log.picks.map(p => ({ overall: p.overall, teamId: p.teamId, playerId: p.playerId, at: p.at ?? null })),
            lastPickAt: status.lastPickAt,
            // Added beside the existing keys. A page that reads the older keys is unaffected.
            transports: [...transports.values()],
            // Shapes and counts, never a frame's text.
            unknownFrames: frameBuffer.frames.slice(),
            notNews: { ...frameBuffer.notNews },
            // The board as the page last showed it, or null before any read. Its picks carry names and no player ids, since the page carries none. Null, not an empty shape, so no read yet can be told from an empty board.
            board: lastBoard
        };
        // The same storage key the extension's pages read, written as a literal since a classic script cannot import the module that names it. The local storage area is used because a content script can write to it by default in both browsers. The staleness rule makes the key a fact about this sitting.
        try {
            await browser.storage.local.set({ roomState: snapshot });
        } catch (err) {
            console.error('Leaguewise: could not write roomState', err && err.message);
        }
        // Sent without waiting for a reply. The extension's page may not be open to hear it, which is not an error: storage is the durable side.
        try {
            const sent = browser.runtime.sendMessage({ kind: 'lw-room', roomState: snapshot });
            if (sent && typeof sent.catch === 'function') sent.catch(() => {});
        } catch { /* no listener open right now is not an error */ }
    }

    // At most one snapshot every 500 milliseconds. A fact that lands inside the window is never lost, only written at the window's edge, so a rapid run of picks ends with every one of them written.
    const SNAPSHOT_THROTTLE_MS = 500;
    let lastSnapshotAt = 0;
    let snapshotTimer = null;
    function scheduleSnapshot() {
        const now = Date.now();
        const elapsed = now - lastSnapshotAt;
        if (elapsed >= SNAPSHOT_THROTTLE_MS) {
            lastSnapshotAt = now;
            writeSnapshot();
            return;
        }
        if (snapshotTimer) return;
        snapshotTimer = setTimeout(() => {
            snapshotTimer = null;
            lastSnapshotAt = Date.now();
            writeSnapshot();
        }, SNAPSHOT_THROTTLE_MS - elapsed);
    }

    // ==== The board read: the recovery, and when it is allowed to run ====

    // A read of the board is costly, so it happens on three occasions and never on a frame: once at the start, when the room's connection closes, and while the room is quiet, at most once an interval and only if no frame arrived in it. No observer is set on the board, since ESPN redraws its cells often and each redraw carries no new fact.
    const BOARD_READ_MIN_MS = 60000;
    let lastBoardSignature = null;
    let lastFrameAt = 0;
    let lastBoardReadAt = 0;
    let boardReading = false;

    // Reasons with counts only. A refused cell carries a player's name, and the snapshot holds nothing about anybody.
    function refusalCounts(refused) {
        const byReason = {};
        (refused || []).forEach(row => {
            const reason = row && row.reason ? row.reason : 'unknown';
            byReason[reason] = (byReason[reason] || 0) + 1;
        });
        return Object.keys(byReason).map(reason => ({ reason, count: byReason[reason] }));
    }

    async function readBoardNow(why) {
        const dom = window.__leaguewiseRoomDom;
        // A second read cannot start while one is running, since an import is awaited in the middle and two reads would write the same board twice.
        if (!dom || boardReading) return null;
        boardReading = true;
        try {
            const { boardDomPicks } = await loadRoomFeed();
            const cells = dom.readBoardCells(document);
            // No board on the page means nothing is read. The pick history's rows are never a fallback: they are one window of a longer list, and a partial board read as a whole one would renumber the picks.
            if (!cells.length) return null;
            const columns = dom.readBoardColumns(document);
            const read = boardDomPicks(cells, columns ? { columns } : {});
            if (!read.picks.length) return null;
            lastBoardReadAt = Date.now();
            const signature = dom.boardSignature(read.picks);
            // An unchanged board writes nothing. The read still counts as done, so a quiet room does not read again on the next tick.
            if (signature === lastBoardSignature) return read;
            lastBoardSignature = signature;
            lastBoard = {
                at: lastBoardReadAt,
                why: why || null,
                columns: read.columns,
                rounds: read.rounds,
                picks: read.picks,
                refused: refusalCounts(read.refused)
            };
            writeSnapshot();
            return read;
        } catch (err) {
            // A recovery that cannot run is logged once, and the frames carry on as they were.
            console.error('Leaguewise: could not read the room board', err && err.message);
            return null;
        } finally {
            boardReading = false;
        }
    }

    function startBoardWatch() {
        setInterval(() => {
            const now = Date.now();
            if (now - lastFrameAt < BOARD_READ_MIN_MS) return;       // the room is talking
            if (now - lastBoardReadAt < BOARD_READ_MIN_MS) return;   // already read this interval
            readBoardNow('quiet');
        }, BOARD_READ_MIN_MS);
    }

    // What counts as worth a write: a pick always does. The clock and the turn announcement both carry a team, and one tracker covers both, so a change of the team on the clock is caught whichever frame says it and a repeated tick for the same team changes nothing.
    let lastOnClockTeamId;
    async function handleFrame(data, at, msg) {
        const { parseRoomLine } = await loadRoomFeed();
        const fact = parseRoomLine(data, at);
        // The adoption happens here, since only a parsed fact proves which connection is the room. A frame that does not parse adopts nothing. Once a room is known, a frame from any other endpoint is recorded and dropped.
        const from = typeof (msg && msg.endpoint) === 'string' ? msg.endpoint : null;
        if (roomEndpoint !== null && from !== null && from !== roomEndpoint) {
            noteTransport(msg, 'frame', 'foreign');
            return;
        }
        if (!fact) {
            // A line the parser does not know goes to the diagnosis buffer. This path schedules no write of its own, so a keep-alive every few seconds cannot become a storage write every few seconds. The counts go out with the next write a real fact, an open or a close causes.
            noteUnknownFrame(msg || {}, data);
            return;
        }
        if (roomEndpoint === null && from !== null) {
            roomEndpoint = from;
            console.log('Leaguewise: the room is the ' + (msg.transport || 'ws') + ' channel on ' + from);
        }
        facts.push(fact);
        if (fact.kind === 'joined' && fact.teamId !== null && fact.teamId !== undefined) {
            myTeamId = fact.teamId;
        }
        let material = fact.kind === 'selected';
        if (fact.kind === 'clock' || fact.kind === 'selecting') {
            material = fact.teamId !== lastOnClockTeamId;
            lastOnClockTeamId = fact.teamId;
        }
        if (!material) return;
        scheduleSnapshot();
    }

    // The hook is inserted as a script element with a source address, not as inline text, so it is a separate resource the extension lists as accessible to the page. The room page's own content security policy restricts only framing, so the element is not refused.
    try {
        const script = document.createElement('script');
        script.src = browser.runtime.getURL('src/data/room-hook.js');
        script.async = false;
        (document.head || document.documentElement).appendChild(script);
        script.addEventListener('load', () => script.remove());
    } catch (err) {
        console.error('Leaguewise: could not inject room-hook.js', err && err.message);
    }

    // The Draft press reaches this script as a message from the extension. It never becomes a frame: this finds ESPN's own row by name and presses ESPN's own button. The search box is controlled by React, so its value is set through the native setter on the input's prototype; a plain assignment would not fire React's change handler.
    function setNativeValue(el, value) {
        const proto = Object.getPrototypeOf(el);
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && typeof setter.set === 'function') setter.set.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // A row is found by an exact match on its name text. Every action button in the row is read, and the one whose text is exactly Draft is taken.
    function draftRowButton(name) {
        const nameEls = document.querySelectorAll('.playerinfo__playername');
        for (const el of nameEls) {
            if (el.textContent.trim() !== name) continue;
            const row = el.closest('.fixedDataTableRowLayout_rowWrapper');
            if (!row) continue;
            const btns = row.querySelectorAll('.action-btn');
            for (const btn of btns) {
                if (btn.textContent.trim() === 'Draft') return btn;
            }
        }
        return null;
    }

    // Polled, not a fixed delay, since how long the list takes to redraw is not known. It resolves when the row's button reads Draft and gives up after the timeout, which reads the same as the reader not being on the clock.
    function waitForDraftButton(name, timeoutMs) {
        return new Promise(resolve => {
            const start = Date.now();
            const tick = () => {
                // The button is only ever returned when its text is Draft, so finding it is the whole test.
                const btn = draftRowButton(name);
                if (btn) { resolve(btn); return; }
                if (Date.now() - start >= timeoutMs) { resolve(null); return; }
                setTimeout(tick, 100);
            };
            tick();
        });
    }

    // The search box is cleared afterwards, however the press ends, so the room's list is left unfiltered. It is cleared on a zero timer, after the click's own handler has run.
    function clearSearch(input) {
        setTimeout(() => setNativeValue(input, ''), 0);
    }

    async function handleDraftPush(msg) {
        const name = (msg && msg.name) || '';
        const input = document.querySelector('input[placeholder="Player Name"]');
        if (input) setNativeValue(input, name);
        const btn = await waitForDraftButton(name, 3000);
        if (!btn) {
            if (input) clearSearch(input);
            return { ok: false, why: 'not on the clock' };
        }
        // There is no confirmation step: the click is the pick. The room's own answering frame is what the extension's page waits for, through the same bridge as every other pick.
        btn.click();
        if (input) clearSearch(input);
        return { ok: true };
    }

    // The bridge. The hook posts to this page's own origin, and only a message whose source is this window is acted on. The first bridged message of any kind is logged once, as the earliest proof that the hook is delivering.
    let loggedFirstBridgeMessage = false;
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const msg = event.data;
        if (!msg || msg.lw !== 'room-frame') return;
        if (!loggedFirstBridgeMessage) {
            loggedFirstBridgeMessage = true;
            console.log('Leaguewise: first room-hook message received', msg.dir);
        }
        // Whose event this is. The hook wraps every connection the page opens, and the room's page runs at least one besides the room's own, so each event is classified before anything acts on it.
        const role = classifyRoomEvent(roomEndpoint, msg);
        // An event from another endpoint is recorded and never acted on. It still gets its row among the connections seen, and it cannot change the room's status.
        if (role === 'foreign') {
            noteTransport(msg, msg.dir === 'in' ? 'frame' : (msg.dir === 'error' ? 'error' : msg.dir), 'foreign');
            return;
        }
        // While no endpoint is adopted, an open is recorded and reads as open, and a close or an error is recorded without closing anything.
        if (msg.dir === 'open') { roomStatusOpen = true; noteTransport(msg, 'open', role); writeSnapshot(); return; }
        if (msg.dir === 'close') {
            noteTransport(msg, 'close', role);
            if (role === 'room') {
                roomStatusOpen = false;
                // The frames have stopped, so the board is the only source left. The read is started without waiting on it.
                readBoardNow('room-closed');
            }
            writeSnapshot();
            return;
        }
        // An error on an event stream is not a close, since the stream reconnects by itself. The status is not changed here. The ready state is recorded for a page to read.
        if (msg.dir === 'error') {
            const row = noteTransport(msg, 'error', role);
            if (role === 'room' && row.lastReadyState === 2) roomStatusOpen = false;
            writeSnapshot();
            return;
        }
        // Only incoming frames are read as facts. The handler is asynchronous and the listener cannot wait on it, so it is started and left; calls started close together still add their facts in arrival order.
        if (msg.dir !== 'in') return;
        // Counted before the parse, since a frame arrived on this connection whether or not the parser understands it.
        noteTransport(msg, 'frame', role);
        // The board read's own gate: a room that spoke inside the last interval needs no recovery.
        lastFrameAt = msg.at ?? Date.now();
        handleFrame(msg.data, msg.at, msg);
    });

    // The Draft press arrives on the extension's own message channel, not the bridge above. The reply goes through sendResponse with the listener returning true, since that form works in both browsers for a reply that arrives later.
    browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || msg.kind !== 'lw-draft') return;
        handleDraftPush(msg).then(sendResponse, () => sendResponse({ ok: false, why: 'error' }));
        return true;
    });

    // Started last and not waited on. Everything that could receive a live frame is already listening, and the resume refuses if this sitting has collected any fact of its own by the time it resolves.
    resumeFromSnapshot();

    // After the resume, so a room sending frames never waits on either. A reader that has just restarted is the one that lost the run, and the watch then covers the quiet.
    readBoardNow('start');
    startBoardWatch();
})();
