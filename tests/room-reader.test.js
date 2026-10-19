// Unit tests for the page-world WebSocket hook (room-hook.js) and for room-reader.js's reading of the draft board. Open tests/room-reader.test.html through any static server; green means every assertion held. The rest of room-reader.js is a content script tied to ESPN's own live page and cannot be exercised here.
const results = [];
// The test runner awaits each test's function. Several tests below are asynchronous, since a mirrored frame arrives through a real postMessage round trip, and a runner that did not await would record a pass before the assertions ran. Tests run one at a time, since each asynchronous one installs and removes its own message listener.
async function test(name, fn) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assertEq(got, want, msg) {
    if (got !== want) throw new Error(`${msg}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

// A minimal stand-in for the room's own WebSocket: a real constructor, a real send, a real message event, and nothing else the hook touches.
class StubWebSocket extends EventTarget {
    constructor(url, protocols) {
        super();
        this.url = url;
        this.protocols = protocols;
        this.sent = [];
    }
    send(data) { this.sent.push(data); }
}
StubWebSocket.CONNECTING = 0;
StubWebSocket.OPEN = 1;
StubWebSocket.CLOSING = 2;
StubWebSocket.CLOSED = 3;
window.WebSocket = StubWebSocket;

function loadHook() {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        // Not a module: room-hook.js is a classic script on purpose, and loading it any other way here would prove a different file from the one that ships.
        s.src = '../src/data/room-hook.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('room-hook.js failed to load'));
        document.head.appendChild(s);
    });
}

function nextTick() { return new Promise(resolve => setTimeout(resolve, 0)); }

await loadHook();

await test('WebSocket is wrapped, not replaced with something unrelated', () => {
    assertEq(typeof window.WebSocket, 'function', 'still a constructor');
    assertEq(window.WebSocket.OPEN, 1, 'borrows the wrapped class' + "'" + 's own statics');
});

await test('a sent frame is mirrored out, and the real send still runs', async () => {
    const frames = [];
    const onMsg = (e) => { if (e.data && e.data.lw === 'room-frame') frames.push(e.data); };
    window.addEventListener('message', onMsg);
    const ws = new window.WebSocket('wss://fake/JOIN');
    ws.send('SELECT 4565227');
    await nextTick();
    window.removeEventListener('message', onMsg);
    assertEq(frames.length, 1, 'one mirrored frame');
    assertEq(frames[0].dir, 'out', 'a sent frame is dir out');
    assertEq(frames[0].data, 'SELECT 4565227', 'the exact line, unmodified');
    assertEq(typeof frames[0].at, 'number', 'stamped with a time');
    assertEq(ws.sent[0], 'SELECT 4565227', 'the underlying send still ran - the hook mirrors, it never replaces');
});

await test('a received frame is mirrored in', async () => {
    const frames = [];
    const onMsg = (e) => { if (e.data && e.data.lw === 'room-frame') frames.push(e.data); };
    window.addEventListener('message', onMsg);
    const ws = new window.WebSocket('wss://fake/JOIN');
    ws.dispatchEvent(new MessageEvent('message', { data: 'SELECTED 2 4565227 10' }));
    await nextTick();
    window.removeEventListener('message', onMsg);
    assertEq(frames.length, 1, 'one mirrored frame');
    assertEq(frames[0].dir, 'in', 'a received frame is dir in');
    assertEq(frames[0].data, 'SELECTED 2 4565227 10', 'the exact line');
});

await test('a non-string frame is stringified, never thrown past', async () => {
    const frames = [];
    const onMsg = (e) => { if (e.data && e.data.lw === 'room-frame') frames.push(e.data); };
    window.addEventListener('message', onMsg);
    const ws = new window.WebSocket('wss://fake/JOIN');
    ws.dispatchEvent(new MessageEvent('message', { data: 42 }));
    await nextTick();
    window.removeEventListener('message', onMsg);
    assertEq(frames.length, 1, 'still mirrored');
    assertEq(frames[0].data, '42', 'coerced to a string, the same shape every text frame carries');
});

await test('the socket opening is mirrored as dir open, carrying no frame', async () => {
    const frames = [];
    const onMsg = (e) => { if (e.data && e.data.lw === 'room-frame') frames.push(e.data); };
    window.addEventListener('message', onMsg);
    const ws = new window.WebSocket('wss://fake/JOIN');
    ws.dispatchEvent(new Event('open'));
    await nextTick();
    window.removeEventListener('message', onMsg);
    assertEq(frames.length, 1, 'one mirrored frame');
    assertEq(frames[0].dir, 'open', 'the socket connecting is dir open');
    assertEq(frames[0].data, '', 'no frame, just the event');
});

await test('the socket closing is mirrored as dir close, carrying no frame', async () => {
    const frames = [];
    const onMsg = (e) => { if (e.data && e.data.lw === 'room-frame') frames.push(e.data); };
    window.addEventListener('message', onMsg);
    const ws = new window.WebSocket('wss://fake/JOIN');
    ws.dispatchEvent(new Event('close'));
    await nextTick();
    window.removeEventListener('message', onMsg);
    assertEq(frames.length, 1, 'one mirrored frame');
    assertEq(frames[0].dir, 'close', 'the socket ending is dir close');
});

await test('the hook installs once - loading it again does not double-wrap', async () => {
    const before = window.WebSocket;
    await loadHook();
    assertEq(window.WebSocket, before, 'the __lwRoomHooked guard means the SAME constructor, not wrapped a second time');
});

const summary = document.getElementById('summary');
const out = document.getElementById('results');

// The board read. room-reader.js's reading of the page is exercised on tests/fixtures/room-board.html, a synthetic board with invented names. The three functions under test are defined before the content script's check of the page address, so loading the file here gives the suite the readers and nothing else runs. What is proven is that ESPN's markup arrives as the plain objects room-feed.js's suite takes.
function loadReader() {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '../src/data/room-reader.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('room-reader.js failed to load'));
        document.head.appendChild(s);
    });
}

await loadReader();
const DOM = window.__leaguewiseRoomDom;
const boardHtml = await (await fetch('fixtures/room-board.html')).text();
function boardRoot() {
    const host = document.createElement('div');
    // The fixture is a whole page; its body is what a room's own document holds.
    host.innerHTML = boardHtml.replace(/[\s\S]*<body>/, '').replace(/<\/body>[\s\S]*/, '');
    return host;
}

await test('the seam is exposed before the pathname gate, and the gate held', () => {
    assertEq(typeof DOM, 'object', 'the readers are available');
    assertEq(typeof DOM.readBoardCells, 'function', 'readBoardCells');
    assertEq(typeof DOM.readBoardColumns, 'function', 'readBoardColumns');
    assertEq(typeof DOM.boardSignature, 'function', 'boardSignature');
    // The content script's own work runs only on a draft address, and this page is not one, so the three readers are all of the file that ran. The hook script is in this page because the earlier tests load it, so its presence proves nothing either way.
    assertEq(location.pathname.indexOf('/draft'), -1, 'this page is not a draft url');
});

await test('a hidden board reads exactly as a visible one would', () => {
    // The fixture's board sits inside ESPN's own display-none utility, as the measured page carried it (Amendment 6, fact 6: the Players tab was selected and all 286 cells were in the DOM behind it). Put into a live document so the rule really does apply, rather than asserted on a detached tree.
    const root = boardRoot();
    root.style.display = 'none';
    document.body.appendChild(root);
    try {
        const panel = root.querySelector('.tab__item.dn');
        assertEq(panel !== null, true, 'the fixture is the hidden case');
        assertEq(getComputedStyle(panel).display, 'none', 'and it really is not displayed');
        assertEq(DOM.readBoardCells(root).length, 10, 'the read is unaffected by that');
        assertEq(DOM.readBoardColumns(root), 3, 'header included');
    } finally {
        root.remove();
    }
});

await test('every completed cell arrives as a plain object', () => {
    const cells = DOM.readBoardCells(boardRoot());
    // Eleven cells are in the markup: nine completed, one without completedPick and one completed with an empty roundPick. The unmade slot is never read; the empty roundPick IS read and refused later.
    assertEq(cells.length, 10, 'the unmade slot is not read');
    assertEq(cells[0].round, 1, 'the round, off the cell\'s own text');
    assertEq(cells[0].pickInRound, 1, 'and the pick number');
    assertEq(cells[0].row, 1, 'the grid-area row');
    assertEq(cells[0].column, 1, 'and its column');
    assertEq(cells[0].mine, true, 'myTeam, by ESPN\'s own class');
    assertEq(cells[1].mine, false, 'and absent on another team\'s cell');
    assertEq(cells[0].firstName, 'Ada', 'first name');
    assertEq(cells[0].lastName, 'Lovel', 'last name');
    assertEq(cells[0].proTeam, 'AAA', 'club');
    assertEq(cells[0].position, 'C', 'position pill');
    assertEq(cells[9].round, null, 'an empty roundPick reads null rather than 0');
    assertEq(cells[9].pickInRound, null, 'both halves');
});

await test('the header row gives the grid its width', () => {
    assertEq(DOM.readBoardColumns(boardRoot()), 3, 'three columns');
    assertEq(DOM.readBoardColumns(document.createElement('div')), 0, 'no header, no width');
    assertEq(DOM.readBoardColumns(null), 0, 'and no throw');
});

await test('the fixture reads end to end into facts', async () => {
    const { boardDomPicks, domPickFacts } = await import('../src/data/room-feed.js');
    const root = boardRoot();
    const read = boardDomPicks(DOM.readBoardCells(root), { columns: DOM.readBoardColumns(root) });
    assertEq(read.picks.length, 9, 'nine placed picks');
    assertEq(read.columns, 3, 'the header\'s width');
    assertEq(read.rounds, 3, 'three rounds');
    assertEq(read.refused.length, 1, 'the empty-roundPick cell refused');
    assertEq(read.refused[0].reason, 'no-round', 'with its reason');
    assertEq(read.picks.map(p => p.overall).join(','), '1,2,3,4,5,6,7,8,9', 'overalls 1..9');
    assertEq(read.picks[3].name, 'Dee Knuth', 'round 2 pick 1 is the reversed column');
    const pool = { 'Ada Lovel': 9001, 'Bea Turing': 9002, 'Cyd Hopper': 9003, 'Dee Knuth': 9004,
        'Eli Church': 9005, 'Fay Dijkst': 9006, 'Gus Backus': 9007, 'Hal Ritchie': 9008, 'Ivy Lamport': 9009 };
    const facts = domPickFacts(read.picks, { playerIdOf: (p) => pool[p.name] ?? null });
    assertEq(facts.facts.length, 9, 'nine facts, the whole run');
    assertEq(facts.held.length, 0, 'nothing held');
    assertEq(facts.facts[0].kind, 'selected', 'parseRoomLine\'s own shape');
});

await test('no board in the DOM reads as nothing, never as a partial one', () => {
    const root = boardRoot();
    root.querySelector('.draftBoardGrid').remove();
    assertEq(DOM.readBoardCells(root).length, 0, 'no cells');
    // The Pick History's own rows are still in a real room's DOM when the grid is missing, and they are deliberately not reached for: one window of a virtualised table is not a board.
    assertEq(DOM.readBoardCells(document.createElement('div')).length, 0, 'an empty root');
    assertEq(DOM.readBoardCells(null).length, 0, 'and no throw on nothing at all');
});

await test('an unchanged board signs the same, a changed one does not', async () => {
    const { boardDomPicks } = await import('../src/data/room-feed.js');
    const first = boardDomPicks(DOM.readBoardCells(boardRoot()), { columns: 3 });
    const again = boardDomPicks(DOM.readBoardCells(boardRoot()), { columns: 3 });
    assertEq(DOM.boardSignature(first.picks), DOM.boardSignature(again.picks), 'two reads of one board');
    const root = boardRoot();
    root.querySelectorAll('.playerLastName')[4].textContent = 'Churchill';
    const changed = boardDomPicks(DOM.readBoardCells(root), { columns: 3 });
    assertEq(DOM.boardSignature(changed.picks) === DOM.boardSignature(first.picks), false, 'one name changed');
    const shorter = boardDomPicks(first.picks.slice(0, 8).map(p => ({
        round: p.round, pickInRound: p.pickInRound, column: p.column, row: p.round,
        mine: p.mine, firstName: p.firstName, lastName: p.lastName, proTeam: p.proTeam, position: p.position
    })), { columns: 3 });
    assertEq(DOM.boardSignature(shorter.picks) === DOM.boardSignature(first.picks), false, 'one pick fewer');
});

await test('a full 286-cell board: the cost of one read, measured', async () => {
    const { boardDomPicks } = await import('../src/data/room-feed.js');
    // A board at full size: 13 teams, 22 rounds, a snake, built from the fixture's own cell markup, so the page has the measured structure at the size a real room reaches.
    const template = boardRoot().querySelector('.draft-board-grid-pick-cell.completedPick');
    const host = document.createElement('div');
    const header = document.createElement('div');
    for (let c = 1; c <= 13; c++) {
        const cell = document.createElement('div');
        cell.className = 'draft-board-grid-header-cell' + (c === 1 ? ' myTeam' : '');
        cell.textContent = 'T' + c;
        header.appendChild(cell);
    }
    host.appendChild(header);
    const grid = document.createElement('div');
    grid.className = 'draftBoardGrid';
    for (let round = 1; round <= 22; round++) {
        for (let column = 1; column <= 13; column++) {
            const pickInRound = round % 2 === 1 ? column : 14 - column;
            const cell = template.cloneNode(true);
            cell.setAttribute('style', `grid-area: ${round} / ${column};`);
            cell.querySelector('.roundPick').textContent = `${round}.${pickInRound}`;
            cell.querySelector('.playerFirstName').textContent = 'P' + round;
            cell.querySelector('.playerLastName').textContent = 'C' + column;
            grid.appendChild(cell);
        }
    }
    host.appendChild(grid);

    const started = performance.now();
    const cells = DOM.readBoardCells(host);
    const read = boardDomPicks(cells, { columns: DOM.readBoardColumns(host) });
    const signature = DOM.boardSignature(read.picks);
    const ms = performance.now() - started;

    assertEq(cells.length, 286, '286 cells read');
    assertEq(read.picks.length, 286, 'all placed');
    assertEq(read.refused.length, 0, 'none refused');
    assertEq(read.columns, 13, 'thirteen columns');
    assertEq(read.rounds, 22, 'twenty-two rounds');
    assertEq(read.picks[read.picks.length - 1].overall, 286, 'the last overall');
    assertEq(typeof signature, 'string', 'and it signs');
    // Reported rather than asserted against a threshold: a machine's own speed is not a contract. The figure is what the commit body and the report quote.
    window.__BOARD_READ_MS = Math.round(ms * 100) / 100;
    console.log('B267 item 4b: one read of a 286-cell board, extraction through signature:', window.__BOARD_READ_MS, 'ms');
    assertEq(ms < 2000, true, 'a read is not a hang, on any machine this could run on');
});
const passed = results.filter(r => r.ok).length;
summary.textContent = `${passed}/${results.length} passed`;
summary.className = passed === results.length ? 'pass' : 'fail';
out.innerHTML = results.map(r =>
    `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' - ' + r.err}</div>`
).join('');
