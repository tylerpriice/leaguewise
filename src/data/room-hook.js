/**
 * Runs in the page's own world on ESPN's draft room page, not in the extension's scope. The
 * content script, room-reader.js, injects it as a script before the room opens its connection. A
 * content script runs in an isolated world and cannot see the page's own WebSocket; this file can.
 *
 * It wraps the constructors the room's own code already calls, WebSocket and EventSource, and
 * mirrors every frame the room's own client sends or receives. It never opens a connection of its
 * own. The fetch and XMLHttpRequest interfaces are not wrapped, so a room that streamed over
 * either would not be seen.
 *
 * Frames are passed to the content script with postMessage, addressed to the page's own origin and
 * never to any origin, so no other listener on the page is handed one.
 *
 * A classic script, not a module: it imports nothing and exports nothing.
 *
 * @file
 */
(function () {
    if (window.__lwRoomHooked) return;
    window.__lwRoomHooked = true;

    const NativeWebSocket = window.WebSocket;
    if (typeof NativeWebSocket !== 'function') return;

    // The masked endpoint, restated here on purpose: this file is a classic script in the page's world and can import nothing, so it cannot use room-feed.js's endpointShape. The rule is the same one: the query is dropped whole, since it carries the token that identifies the reader, and ids in the path are masked.
    function shapeOf(url) {
        if (typeof url !== 'string') return null;
        const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]+)([^?#]*)/.exec(url.trim());
        if (!m) return null;
        const path = (m[3] || '').split('/').map(seg => {
            if (/^game-\d+$/.test(seg)) return 'game-<n>';
            if (/^league-\d+$/.test(seg)) return 'league-<id>';
            if (/^[A-Za-z0-9%_~.=-]{20,}$/.test(seg)) return '<tok>';
            return seg;
        }).join('/');
        return m[2] + path;
    }

    function post(dir, data, extra) {
        // A frame that cannot be turned into text is skipped, not thrown, so one odd frame does not stop the hook.
        let text;
        try { text = typeof data === 'string' ? data : String(data); } catch { return; }
        const msg = { lw: 'room-frame', dir, data: text, at: Date.now() };
        if (extra) {
            // Assigned key by key, not spread, to stay within the syntax the rest of this classic script uses.
            for (const k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k];
        }
        try {
            window.postMessage(msg, window.location.origin);
        } catch { /* nothing else to do with a postMessage that itself throws */ }
    }

    function LWHookedWebSocket(url, protocols) {
        const ws = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
        const shape = shapeOf(url);
        // A listener is added for the message event and the handler property is left alone, since the room's own client may set that property. The endpoint travels with every frame, since the reader decides which connection is the room by which one sends frames.
        ws.addEventListener('message', (e) => post('in', e.data, { transport: 'ws', endpoint: shape }));
        // Open and close are mirrored too, so the reader's status follows the room's connection at once. Neither carries data. Each names its transport and its masked endpoint: host and path only, never the query.
        ws.addEventListener('open', () => post('open', '', { transport: 'ws', endpoint: shape }));
        ws.addEventListener('close', () => post('close', '', { transport: 'ws', endpoint: shape }));
        // The send method is wrapped on the instance, not the prototype, so each socket has its own wrapped copy and the prototype's is untouched.
        const nativeSend = ws.send.bind(ws);
        ws.send = function (data) {
            post('out', data);
            return nativeSend(data);
        };
        return ws;
    }
    // The room's own code may read the class-level constants or test an instance against the prototype. Both must resolve as they would for the native constructor, so the hook borrows them.
    LWHookedWebSocket.prototype = NativeWebSocket.prototype;
    LWHookedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
    LWHookedWebSocket.OPEN = NativeWebSocket.OPEN;
    LWHookedWebSocket.CLOSING = NativeWebSocket.CLOSING;
    LWHookedWebSocket.CLOSED = NativeWebSocket.CLOSED;

    window.WebSocket = LWHookedWebSocket;

    // The second transport. An EventSource only receives, so there is no send to wrap. A client may subscribe to a named event type, and a named event does not fire the message event, so every name the page subscribes to is mirrored, carrying that name.
    const NativeEventSource = window.EventSource;
    if (typeof NativeEventSource === 'function') {
        function LWHookedEventSource(url, config) {
            const es = config === undefined ? new NativeEventSource(url) : new NativeEventSource(url, config);
            const shape = shapeOf(url);
            const seen = Object.create(null);
            // The message event is subscribed here so the default event is mirrored whether or not the page asks for it. A name is never mirrored twice.
            seen.message = true;
            es.addEventListener('message', (e) => post('in', e.data, { transport: 'sse', event: 'message', endpoint: shape }));
            // An error is not a close. An EventSource fires an error on every failed poll and then reconnects by itself. The error goes over with the ready state, and only the closed state means it has given up.
            es.addEventListener('error', () => post('error', '', {
                transport: 'sse', endpoint: shape,
                readyState: typeof es.readyState === 'number' ? es.readyState : null
            }));
            es.addEventListener('open', () => post('open', '', { transport: 'sse', endpoint: shape }));

            // The listener method is wrapped on the instance, for the named events. The native one still runs: this adds a listener beside the page's own, never in its place.
            const nativeAdd = es.addEventListener.bind(es);
            es.addEventListener = function (type, listener, options) {
                if (typeof type === 'string' && !seen[type] && type !== 'open' && type !== 'error') {
                    seen[type] = true;
                    nativeAdd(type, (e) => post('in', e.data, { transport: 'sse', event: type, endpoint: shape }));
                }
                return nativeAdd(type, listener, options);
            };
            // A handler the page sets on the message property still leaves this hook's listener in place, so nothing more needs wrapping.
            return es;
        }
        LWHookedEventSource.prototype = NativeEventSource.prototype;
        LWHookedEventSource.CONNECTING = NativeEventSource.CONNECTING;
        LWHookedEventSource.OPEN = NativeEventSource.OPEN;
        LWHookedEventSource.CLOSED = NativeEventSource.CLOSED;
        window.EventSource = LWHookedEventSource;
    }
})();
