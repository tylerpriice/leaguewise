// Unit tests for the page-world hook's second transport (room-hook.js). Open tests/room-hook.test.html through any static server; green means every assertion held. A hook can be installed only once per page, so the fake EventSource must be in place before the file loads, hence a page of its own. No room is involved: the tests prove a frame arrives with its transport, its event name and its masked endpoint intact.
const results = [];
// AWAITS fn(), for the reason tests/room-reader.test.js records at length: a mirrored frame arrives through a real postMessage round trip, so a test() that does not await its own async body reports "passed" the instant that body returns its promise.
async function test(name, fn) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assertEq(got, want, msg) {
    if (got !== want) throw new Error(`${msg}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// A stand-in for the room's own EventSource: a real constructor, real events, a readyState the hook reads on an error, and nothing else the hook touches. EventTarget gives real dispatch, so the hook's own listeners run exactly as they would on the platform object.
class StubEventSource extends EventTarget {
    constructor(url, config) {
        super();
        this.url = url;
        this.config = config;
        this.readyState = 0;
        this.onmessage = null;
        // The platform fires onmessage for the default event as well as any listener; mirrored here so the "the page sets onmessage" case is proven against the same behaviour.
        this.addEventListener('message', (e) => { if (typeof this.onmessage === 'function') this.onmessage(e); });
    }
    close() { this.readyState = 2; }
}
StubEventSource.CONNECTING = 0;
StubEventSource.OPEN = 1;
StubEventSource.CLOSED = 2;

class StubWebSocket extends EventTarget {
    constructor(url, protocols) { super(); this.url = url; this.protocols = protocols; this.sent = []; }
    send(data) { this.sent.push(data); }
}
StubWebSocket.CONNECTING = 0;
StubWebSocket.OPEN = 1;
StubWebSocket.CLOSING = 2;
StubWebSocket.CLOSED = 3;

// BOTH FAKES BEFORE THE HOOK LOADS. The hook reads window.EventSource and window.WebSocket once, at install, so anything installed after it would be wrapping nothing.
window.EventSource = StubEventSource;
window.WebSocket = StubWebSocket;

function loadHook() {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        // Not a module: room-hook.js is a classic script on purpose, and loading it any other way would prove a different file from the one that ships.
        s.src = '../src/data/room-hook.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('room-hook.js failed to load'));
        document.head.appendChild(s);
    });
}
function nextTick() { return new Promise(resolve => setTimeout(resolve, 0)); }
// Collects every bridged frame for the length of one action and then stops listening, since two tests listening at once would let one test's frame be counted by another.
async function bridged(fn) {
    const frames = [];
    const onMsg = (e) => { if (e.data && e.data.lw === 'room-frame') frames.push(e.data); };
    window.addEventListener('message', onMsg);
    await fn();
    await nextTick();
    window.removeEventListener('message', onMsg);
    return frames;
}

const SSE_URL = 'https://fantasydraft.espn.com/game-4/league-100200300/sse/JOIN?1=a&2=b&nocache=1';
const WS_URL = 'wss://fantasydraft.espn.com/game-4/league-100200300/JOIN?1=a&nocache=1';
const SSE_SHAPE = 'fantasydraft.espn.com/game-<n>/league-<id>/sse/JOIN';
const WS_SHAPE = 'fantasydraft.espn.com/game-<n>/league-<id>/JOIN';

await loadHook();

await test('EventSource is wrapped, not replaced with something unrelated', () => {
    assertEq(typeof window.EventSource, 'function', 'still a constructor');
    assertEq(window.EventSource.CLOSED, 2, 'borrows the wrapped class own statics');
    assert(new window.EventSource(SSE_URL) instanceof StubEventSource, 'and the instance is still the real thing');
});

await test('the stream opening is mirrored with its transport and masked endpoint', async () => {
    const frames = await bridged(() => {
        const es = new window.EventSource(SSE_URL);
        es.dispatchEvent(new Event('open'));
    });
    assertEq(frames.length, 1, 'one mirrored frame');
    assertEq(frames[0].dir, 'open', 'dir open');
    assertEq(frames[0].transport, 'sse', 'named as sse, which is the state the strip could not tell before');
    assertEq(frames[0].endpoint, SSE_SHAPE, 'host and path, ids masked');
    assertEq(frames[0].data, '', 'no frame, just the event');
});

await test('NOTHING from the query reaches the bridge', () => {
    // The rule this shares with request-log.js and with room-feed.js endpointShape: this JOIN query carries the token that identifies the reader, so it is dropped WHOLE rather than filtered.
    assertEq(SSE_SHAPE.indexOf('?'), -1, 'the expected shape has no query marker');
    assertEq(SSE_SHAPE.indexOf('nocache'), -1, 'and no parameter name');
    assertEq(SSE_SHAPE.indexOf('100200300'), -1, 'and the league id is masked out of the path too');
});

await test('a default message is mirrored in, carrying its event name', async () => {
    const frames = await bridged(() => {
        const es = new window.EventSource(SSE_URL);
        es.dispatchEvent(new MessageEvent('message', { data: 'SELECTED 2 4565227 10' }));
    });
    assertEq(frames.length, 1, 'one mirrored frame');
    assertEq(frames[0].dir, 'in', 'a received frame is dir in');
    assertEq(frames[0].data, 'SELECTED 2 4565227 10', 'the exact line, unmodified');
    assertEq(frames[0].transport, 'sse', 'and which transport carried it');
    assertEq(frames[0].event, 'message', 'the default event is named rather than assumed');
});

await test('a NAMED event the page subscribes to is mirrored under its own name', async () => {
    // The case that would otherwise read as silence: a named SSE event does not fire 'message' at all, so a hook watching only 'message' would report an open stream and no frames while the room talked. Amendment 2 lists "whether ESPN sets a named event type" as unknown, which is exactly why this is covered rather than assumed away.
    const frames = await bridged(async () => {
        const es = new window.EventSource(SSE_URL);
        es.addEventListener('pick', () => {});
        await nextTick();
        es.dispatchEvent(new MessageEvent('pick', { data: 'SELECTED 3 1234' }));
    });
    assertEq(frames.length, 1, 'the named frame came through');
    assertEq(frames[0].event, 'pick', 'under its own name');
    assertEq(frames[0].data, 'SELECTED 3 1234', 'with its line intact');
});

await test('the page own listener still runs - the hook adds, never replaces', async () => {
    let heard = null;
    await bridged(async () => {
        const es = new window.EventSource(SSE_URL);
        es.addEventListener('pick', (e) => { heard = e.data; });
        await nextTick();
        es.dispatchEvent(new MessageEvent('pick', { data: 'SELECTED 4 9' }));
    });
    assertEq(heard, 'SELECTED 4 9', 'the room own handler heard its frame');
});

await test('onmessage set by the page reaches both it and the bridge', async () => {
    let heard = null;
    const frames = await bridged(async () => {
        const es = new window.EventSource(SSE_URL);
        es.onmessage = (e) => { heard = e.data; };
        es.dispatchEvent(new MessageEvent('message', { data: 'CLOCK 7 48000 2' }));
    });
    assertEq(heard, 'CLOCK 7 48000 2', 'the page own onmessage still fired');
    assertEq(frames.length, 1, 'and the frame was still mirrored');
    assertEq(frames[0].data, 'CLOCK 7 48000 2', 'once, with its line');
});

await test('one name subscribed twice is mirrored once, not twice', async () => {
    const frames = await bridged(async () => {
        const es = new window.EventSource(SSE_URL);
        es.addEventListener('pick', () => {});
        es.addEventListener('pick', () => {});
        await nextTick();
        es.dispatchEvent(new MessageEvent('pick', { data: 'SELECTED 5 5' }));
    });
    assertEq(frames.length, 1, 'a second subscription to the same name adds no second mirror');
});

await test('subscribing to message again does not double the default', async () => {
    const frames = await bridged(async () => {
        const es = new window.EventSource(SSE_URL);
        es.addEventListener('message', () => {});
        await nextTick();
        es.dispatchEvent(new MessageEvent('message', { data: 'STATE 2' }));
    });
    assertEq(frames.length, 1, 'the hook already covers message and does not add a second listener');
});

await test('an ERROR is its own dir with a readyState, never a close', async () => {
    // An EventSource fires an error on every failed poll and then reconnects by itself. Bridging that as a close would tell the reader the draft ended every time the network faltered.
    const frames = await bridged(() => {
        const es = new window.EventSource(SSE_URL);
        es.readyState = 0;
        es.dispatchEvent(new Event('error'));
    });
    assertEq(frames.length, 1, 'one mirrored event');
    assertEq(frames[0].dir, 'error', 'its own dir');
    assert(frames[0].dir !== 'close', 'and emphatically not a close');
    assertEq(frames[0].readyState, 0, 'CONNECTING - it is reconnecting, not finished');
    assertEq(frames[0].transport, 'sse', 'named');
});

await test('an error after the stream has given up carries CLOSED', async () => {
    const frames = await bridged(() => {
        const es = new window.EventSource(SSE_URL);
        es.readyState = 2;
        es.dispatchEvent(new Event('error'));
    });
    assertEq(frames[0].readyState, 2, 'CLOSED is the one value that means it stopped trying');
});

await test('a non-string SSE frame is stringified, never thrown past', async () => {
    const frames = await bridged(() => {
        const es = new window.EventSource(SSE_URL);
        es.dispatchEvent(new MessageEvent('message', { data: 42 }));
    });
    assertEq(frames.length, 1, 'still mirrored');
    assertEq(frames[0].data, '42', 'coerced, the same shape every text frame carries');
});

await test('the second argument is honoured - withCredentials is the room own choice', () => {
    const es = new window.EventSource(SSE_URL, { withCredentials: true });
    assertEq(es.config && es.config.withCredentials, true, 'passed through to the native constructor');
    const plain = new window.EventSource(SSE_URL);
    assertEq(plain.config, undefined, 'and omitted entirely when the page omits it');
});

await test('the SOCKET open now names its transport too, so the two read alike', async () => {
    const frames = await bridged(() => {
        const ws = new window.WebSocket(WS_URL);
        ws.dispatchEvent(new Event('open'));
    });
    assertEq(frames.length, 1, 'one mirrored frame');
    assertEq(frames[0].transport, 'ws', 'named as ws');
    assertEq(frames[0].endpoint, WS_SHAPE, 'the same masked shape the SSE open carries');
    // One logical JOIN, with the transport chosen by the path.
    assertEq(SSE_SHAPE.replace('/sse/JOIN', '/JOIN'), WS_SHAPE, 'the two differ by the sse segment and nothing else');
});

await test('a socket close names its transport as well', async () => {
    const frames = await bridged(() => {
        const ws = new window.WebSocket(WS_URL);
        ws.dispatchEvent(new Event('close'));
    });
    assertEq(frames[0].dir, 'close', 'still a close');
    assertEq(frames[0].transport, 'ws', 'with its transport');
});

await test('a socket send is still mirrored out, and the real send still runs', async () => {
    let ws;
    const frames = await bridged(() => {
        ws = new window.WebSocket(WS_URL);
        ws.send('SELECT 4565227');
    });
    assertEq(frames[0].dir, 'out', 'dir out');
    assertEq(ws.sent[0], 'SELECT 4565227', 'the underlying send ran');
    // AN EVENTSOURCE HAS NO SEND, which is why there is no 'out' case for it: whatever the room sends on that transport goes somewhere this hook does not see (Amendment 2 records it).
    const es = new window.EventSource(SSE_URL);
    assertEq(typeof es.send, 'undefined', 'receive-only, by the platform');
});

await test('an endpoint that cannot be parsed is null rather than a guess', async () => {
    const frames = await bridged(() => {
        const es = new window.EventSource('/relative/sse/JOIN');
        es.dispatchEvent(new Event('open'));
    });
    assertEq(frames[0].endpoint, null, 'a relative url has no host to report');
    assertEq(frames[0].transport, 'sse', 'the transport is still known');
});

await test('EVERY FRAME names its endpoint, which is what lets the reader tell rooms apart', async () => {
    // The endpoint travels with every frame, not only with the open. A frame that does not say where it came from cannot prove which connection is the room, and the reader adopts the room's endpoint from the first frame.
    const wsFrames = await bridged(() => {
        const ws = new window.WebSocket(WS_URL);
        ws.dispatchEvent(new MessageEvent('message', { data: 'SELECTED 2 4565227 10' }));
    });
    assertEq(wsFrames[0].transport, 'ws', 'a socket frame names its transport');
    assertEq(wsFrames[0].endpoint, WS_SHAPE, 'and its masked endpoint');
    const esFrames = await bridged(() => {
        const es = new window.EventSource(SSE_URL);
        es.dispatchEvent(new MessageEvent('message', { data: 'CLOCK 7 48000 2' }));
    });
    assertEq(esFrames[0].endpoint, SSE_SHAPE, 'and a stream frame does too');
    assertEq(esFrames[0].event, 'message', 'beside its event name');
});

await test('a NAMED sse frame carries the endpoint as well', async () => {
    const frames = await bridged(async () => {
        const es = new window.EventSource(SSE_URL);
        es.addEventListener('pick', () => {});
        await nextTick();
        es.dispatchEvent(new MessageEvent('pick', { data: 'SELECTED 3 1234' }));
    });
    assertEq(frames[0].endpoint, SSE_SHAPE, 'the named path is not the forgotten one');
    assertEq(frames[0].event, 'pick', 'under its own name');
});

await test('the hook installs once - loading it again does not double-wrap', async () => {
    const es = window.EventSource;
    const ws = window.WebSocket;
    await loadHook();
    assertEq(window.EventSource, es, 'the __lwRoomHooked guard means the same constructor');
    assertEq(window.WebSocket, ws, 'for both transports');
});

const summary = document.getElementById('summary');
const passed = results.filter(r => r.ok).length;
summary.textContent = `${passed}/${results.length} passed ${passed === results.length ? '✓' : '✗'}`;
summary.className = passed === results.length ? 'pass' : 'fail';
document.getElementById('results').innerHTML = results.map(r =>
    `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' - ' + r.err}</div>`
).join('');
results.filter(r => !r.ok).forEach(r => console.error(`FAIL: ${r.name}: ${r.err}`));
window.__TEST_RESULTS = { passed, failed: results.length - passed, total: results.length, failures: results.filter(r => !r.ok) };
