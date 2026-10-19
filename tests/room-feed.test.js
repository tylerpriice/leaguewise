// Unit tests for the draft room's facts, merge and status (room-feed.js). Open tests/room-feed.test.html through any static server; green means every assertion held. Expected values are hand-computed in tests/fixtures/room-feed.md, never from running the code. Every team, player and line below is invented.
import { parseRoomLine, applyRoomFacts, roomStatus, roomIsStale, ROOM_STALE_MS, endpointShape, roomFrameState, openTransportName, classifyRoomEvent, gridOverallFor, boardDomPicks, domPickFacts, redactFrameData, roomSnapshotExport, roomFrameClass, bufferFrame } from '../src/data/room-feed.js';
import { emptyLog, applyLoggedPick } from '../src/engines/draft-plan.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assertEq(got, want, msg) {
    if (got !== want) throw new Error(`${msg}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
function assertJson(got, want, msg) {
    const a = JSON.stringify(got), b = JSON.stringify(want);
    if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

const FIX = await (await fetch('fixtures/room-feed.json')).json();
const FACTS = FIX.feed.map(f => parseRoomLine(f.line, f.at)).filter(Boolean);
const T0 = 1790445600000;   // the fixture's base, T18:00:00Z

// ==== one line, one fact ====

test('SELECTED: the ids are numbers and the slot is discarded', () => {
    assertJson(parseRoomLine('SELECTED 103 9003 LW', T0),
        { kind: 'selected', teamId: 103, playerId: 9003, at: T0 },
        'the slot is the room lineup decision, not a fact about the pick');
    assertJson(parseRoomLine('SELECTED 102 9002', T0),
        { kind: 'selected', teamId: 102, playerId: 9002, at: T0 },
        'and the slot is optional');
});

test('SELECTING, CLOCK, STATE and AUTODRAFT each read', () => {
    assertJson(parseRoomLine('SELECTING 105 60000', T0),
        { kind: 'selecting', teamId: 105, msRemaining: 60000, at: T0 }, 'the clock is read as msRemaining');
    assertJson(parseRoomLine('CLOCK 2 12000', T0),
        { kind: 'clock', seq: 2, msRemaining: 12000, teamId: null, at: T0 },
        'seq then msRemaining, and no team on this one');
    assertJson(parseRoomLine('STATE 1', T0), { kind: 'state', n: 1, at: T0 }, 'the number, uninterpreted');
    assertJson(parseRoomLine('AUTODRAFT 104 true', T0),
        { kind: 'autodraft', teamId: 104, on: true, at: T0 }, 'true');
    assertEq(parseRoomLine('AUTODRAFT 104 0', T0).on, false, 'and 0 is off');
});

test('TOKEN, PING, PONG and AUTOSUGGEST are null, and so is anything unknown', () => {
    assertEq(parseRoomLine('TOKEN 4:1234:101:{SWID}:792151115', T0), null, 'the token says nothing happened');
    assertEq(parseRoomLine('PING 1790445652000', T0), null, 'keepalive');
    assertEq(parseRoomLine('PONG', T0), null, 'keepalive');
    // Named rather than left unhandled: the room's hint to the client on the clock.
    assertEq(parseRoomLine('AUTOSUGGEST 9007', T0), null, 'a suggestion is not a pick');
    assertEq(parseRoomLine('HELLO 1 2', T0), null, 'an unknown verb');
    assertEq(parseRoomLine('', T0), null, 'a blank line');
    assertEq(parseRoomLine(null, T0), null, 'nothing at all');
});

test('the verb is case-insensitive and the spacing is forgiven', () => {
    assertJson(parseRoomLine('selected 103 9003', T0),
        { kind: 'selected', teamId: 103, playerId: 9003, at: T0 }, 'lower case');
    assertJson(parseRoomLine('  SELECTED   103   9003  \n', T0),
        { kind: 'selected', teamId: 103, playerId: 9003, at: T0 }, 'runs of spaces and a trailing newline');
});

test('an unreadable quantity is no fact; an id is only required to be there', () => {
    assertEq(parseRoomLine('CLOCK two 12000', T0), null, 'a seq that is not a number');
    assertEq(parseRoomLine('SELECTING 105 soon', T0), null, 'a clock that is not a number');
    assertEq(parseRoomLine('STATE', T0), null, 'no number at all');
    assertEq(parseRoomLine('AUTODRAFT 104 maybe', T0), null, 'a flag that is neither');
    assertEq(parseRoomLine('SELECTED 103', T0), null, 'a pick with no player');
    // An id is whatever the room called it. A future capture naming a team "T3" still parses.
    assertEq(parseRoomLine('SELECTED T3 9003', T0).teamId, 'T3', 'a non-numeric id stays the string');
});

test('a missing arrival time is null, not a date in 1970', () => {
    assertEq(parseRoomLine('SELECTED 103 9003').at, null, 'the reader always sets one; this says it did not');
});

test('the whole fixture: 24 lines, 20 facts, 4 nulls, 5 distinct picks', () => {
    assertEq(FIX.feed.length, 24, 'lines');
    assertEq(FACTS.length, 20, 'facts');
    assertEq(FIX.feed.length - FACTS.length, 4, 'TOKEN, PING, PONG, AUTOSUGGEST');
    const selected = FACTS.filter(f => f.kind === 'selected');
    assertEq(selected.length, 10, 'SELECTED lines: five picks, one duplicate, four replayed');
    assertEq(new Set(selected.map(f => f.playerId)).size, 5, 'five players actually drafted');
});

// ==== the merge ====

test('an empty log takes the room whole: five picks, in order, marked room', () => {
    const { log, added, corrected, dropped } = applyRoomFacts(emptyLog(), FACTS);
    assertJson(log.picks, [
        { overall: 1, teamId: 101, playerId: 9001, source: 'room', at: T0 + 31000 },
        { overall: 2, teamId: 102, playerId: 9002, source: 'room', at: T0 + 51000 },
        { overall: 3, teamId: 103, playerId: 9003, source: 'room', at: T0 + 74000 },
        { overall: 4, teamId: 104, playerId: 9004, source: 'room', at: T0 + 76000 },
        { overall: 5, teamId: 105, playerId: 9005, source: 'room', at: T0 + 112000 }
    ], 'the i-th distinct SELECTED is overall i + 1, and `at` is when it was first reported');
    assertEq(added.length, 5, 'all five are new to the log');
    assertEq(corrected.length, 0, 'nothing to correct in an empty log');
    assertEq(dropped.length, 0, 'and nothing to drop');
});

test('the duplicate SELECTED and the reconnect replay add nothing', () => {
    const first = applyRoomFacts(emptyLog(), FACTS);
    const again = applyRoomFacts(first.log, FACTS);
    assertEq(again.added.length, 0, 'a replay of the whole history adds no pick');
    assertEq(again.corrected.length, 0, 'and corrects none');
    assertJson(again.log.picks, first.log.picks, 'the log compares equal');
    // A new object every time: the same-object convention in draft-plan.js is about a REFUSAL.
    assertEq(again.log === first.log, false, 'a merge that changed nothing is not a refusal');
});

test('a hand pick naming the wrong player is replaced, and listed', () => {
    const { log, added, corrected, dropped } = applyRoomFacts(FIX.logs.handThree, FACTS);
    assertJson(corrected, [{ overall: 3, was: 9009, now: 9003 }], 'the reader heard 9009; the room says 9003');
    assertJson(added, [
        { overall: 4, teamId: 104, playerId: 9004 },
        { overall: 5, teamId: 105, playerId: 9005 }
    ], 'added and corrected are disjoint - overall 3 is a correction, not an addition');
    assertEq(dropped.length, 0, '9009 was replaced in place, not carried past the prefix');
    assertEq(log.picks.length, 5, 'and 9009 is gone from the log: the room is what happened');
    assertEq(log.picks.some(p => p.playerId === 9009), false, 'gone');
});

test('a confirmed hand pick is kept, re-marked, and given the room team it lacked', () => {
    const hand = { picks: [{ overall: 1, teamId: null, playerId: 9001 }] };
    const { log, added, corrected } = applyRoomFacts(hand, FACTS.slice(0, 4));
    assertEq(added.length, 0, 'the pick was already logged, so nothing was added at overall 1');
    assertEq(corrected.length, 0, 'the same player is not a correction');
    assertJson(log.picks[0], { overall: 1, teamId: 101, playerId: 9001, source: 'room', at: T0 + 31000 },
        'a reader who logged what left the board without saying whose it was gets the room team');
});

test('two picks logged in the wrong order correct both overalls', () => {
    // The room says 3 = 9003 then 4 = 9004; the reader logged them the other way round.
    const hand = { picks: [
        { overall: 1, teamId: 101, playerId: 9001 },
        { overall: 2, teamId: 102, playerId: 9002 },
        { overall: 3, teamId: 104, playerId: 9004 },
        { overall: 4, teamId: 103, playerId: 9003 }
    ] };
    const { corrected } = applyRoomFacts(hand, FACTS);
    assertJson(corrected, [
        { overall: 3, was: 9004, now: 9003 },
        { overall: 4, was: 9003, now: 9004 }
    ], 'the prefix rebuild puts both right, and neither change is silent');
});

test('a hand pick beyond the prefix is kept; one the room already placed is dropped', () => {
    // The room has reported three picks. The reader logged four, and their fourth is the player the room put at overall 2 - the same mislabelling as a correction, one slot further on.
    const threePicks = FACTS.filter(f => f.kind !== 'selected' || [9001, 9002, 9003].includes(f.playerId));
    const hand = { picks: [
        { overall: 1, teamId: 101, playerId: 9001 },
        { overall: 2, teamId: 102, playerId: 9002 },
        { overall: 3, teamId: 103, playerId: 9003 },
        { overall: 4, teamId: 104, playerId: 9002 }
    ] };
    const { log, dropped, added } = applyRoomFacts(hand, threePicks);
    assertJson(dropped, [{ overall: 4, playerId: 9002 }], 'a pick that leaves the log leaves a record');
    assertEq(log.picks.length, 3, 'the room prefix alone');
    assertEq(added.length, 0, 'nothing new arrived');
});

test('a hand pick the room has not reached keeps its place and its source', () => {
    const twoPicks = FACTS.filter(f => f.kind !== 'selected' || [9001, 9002].includes(f.playerId));
    const hand = { picks: [
        { overall: 1, teamId: 101, playerId: 9001 },
        { overall: 2, teamId: 102, playerId: 9002 },
        { overall: 3, teamId: 103, playerId: 9011 }
    ] };
    const { log } = applyRoomFacts(hand, twoPicks);
    assertEq(log.picks.length, 3, 'the hand pick beyond the room is kept');
    assertEq(log.picks[2].playerId, 9011, 'at its own overall');
    assertEq(log.picks[2].source, 'hand', 'and absent means hand, so it is stamped hand');
});

test('the merged log is one draft-plan.js would have accepted pick by pick', () => {
    const { log } = applyRoomFacts(FIX.logs.handThree, FACTS);
    // Every pick still went through applyLoggedPick, so the overalls must be 1..n with no repeat - replay the result through an empty log and it must accept every one.
    let replay = emptyLog();
    log.picks.forEach(p => { replay = applyLoggedPick(replay, { overall: p.overall, teamId: p.teamId, playerId: p.playerId }); });
    assertEq(replay.picks.length, log.picks.length, 'the sequence check accepts the whole merged log');
    assertJson(log.picks.map(p => p.overall), [1, 2, 3, 4, 5], 'contiguous from one');
});

test('a log with nothing in it and a feed with nothing in it', () => {
    const { log, added, corrected, dropped } = applyRoomFacts(emptyLog(), []);
    assertEq(log.picks.length, 0, 'no facts, no picks');
    assertEq(added.length + corrected.length + dropped.length, 0, 'and nothing to report');
    assertEq(applyRoomFacts(null, FACTS).log.picks.length, 5, 'no log at all still merges the room');
});

// ==== the status ====

test('the fixture status: five picks in, team 106 on the clock at round 1 pick 6', () => {
    assertJson(roomStatus(FACTS, { order: FIX.order, teams: 6 }), {
        onClock: { teamId: 106, round: 1, pick: 6 },
        msRemaining: 60000,
        lastPickAt: T0 + 112000,
        picks: 5,
        state: 1
    }, 'the team from the last SELECTING, the round and pick from the count of five');
});

test('the teams are counted off the order when none is given', () => {
    const byOrder = roomStatus(FACTS, { order: FIX.order });
    assertEq(byOrder.onClock.round, 1, 'six distinct ids in the order');
    assertEq(byOrder.onClock.pick, 6, 'pick six of round one');
    const none = roomStatus(FACTS, {});
    assertEq(none.onClock.round, null, 'nothing to count against is null, not round one');
});

test('the clock decays against now and floors at zero', () => {
    const at = T0 + 113000;   // the last SELECTING's own arrival
    assertEq(roomStatus(FACTS, { teams: 6, now: at + 3000 }).msRemaining, 57000, '60000 less three seconds');
    assertEq(roomStatus(FACTS, { teams: 6, now: at + 90000 }).msRemaining, 0, 'never past the buzzer');
    assertEq(roomStatus(FACTS, { teams: 6 }).msRemaining, 60000, 'without now, what the room last said');
});

test('the later of CLOCK and SELECTING carries the figure', () => {
    const facts = [
        { kind: 'selecting', teamId: 101, msRemaining: 60000, at: T0 },
        { kind: 'clock', seq: 9, msRemaining: 30000, at: T0 + 30000 }
    ];
    assertEq(roomStatus(facts, { teams: 6 }).msRemaining, 30000, 'the CLOCK arrived later');
    assertEq(roomStatus(facts.slice(0, 1), { teams: 6 }).msRemaining, 60000, 'with no CLOCK, the SELECTING');
});

test('a replay does not move the last pick time', () => {
    const live = FACTS.filter(f => f.at <= T0 + 76000);          // through the fourth pick
    const replayed = live.concat(FACTS.filter(f => f.at >= T0 + 90000 && f.at <= T0 + 90400));
    assertEq(roomStatus(live, { teams: 6 }).lastPickAt, T0 + 76000, 'the fourth pick landed at 76 s');
    assertEq(roomStatus(replayed, { teams: 6 }).lastPickAt, T0 + 76000,
        'and a reconnect replaying it at 90 s does not make it one second old');
    assertEq(roomStatus(replayed, { teams: 6 }).picks, 4, 'nor does it add a fifth pick');
});

test('an empty feed is a room that has reported nothing', () => {
    assertJson(roomStatus([], { order: FIX.order }),
        { onClock: null, msRemaining: null, lastPickAt: null, picks: 0, state: null },
        'not a draft at pick one');
    assertJson(roomStatus(null, {}),
        { onClock: null, msRemaining: null, lastPickAt: null, picks: 0, state: null }, 'nor is nothing at all');
});

// ==== the stored snapshot ====

test('a snapshot goes stale after thirty seconds, and so does no snapshot at all', () => {
    assertEq(ROOM_STALE_MS, 30000, 'the one number both faces read');
    const snap = { status: 'open', at: T0 };
    assertEq(roomIsStale(snap, T0 + 29000), false, 'fresh');
    assertEq(roomIsStale(snap, T0 + 30001), true, 'past thirty seconds the reader has stopped');
    assertEq(roomIsStale({ status: 'closed', at: T0 }, T0), true, 'a closed room is stale however recent');
    assertEq(roomIsStale(null, T0), true, 'no snapshot');
    assertEq(roomIsStale({ status: 'open' }, T0), true, 'a snapshot with no time cannot be believed');
});

// The real frames. A recorded practice room confirmed the vocabulary: every verb arrived in the shape expected. These cases cover the four additions and the two frames the client sends. The ids, the clocks and the arrival times are the recording's own; the session id, the token and the opening blob are invented in the fixture.

const CAP = FIX.capture.feed;
const capFacts = CAP.map(f => parseRoomLine(f.line, f.at)).filter(Boolean);

test('the capture slice: 33 lines, 22 facts, 11 that say nothing', () => {
    assertEq(CAP.length, 33, 'lines');
    assertEq(capFacts.length, 22, 'facts');
    assertEq(CAP.length - capFacts.length, 11, 'INIT, TOKEN, three AUTOSUGGEST, two PING, two PONG, the client AUTODRAFT and SELECT');
    const picks = capFacts.filter(f => f.kind === 'selected');
    assertEq(picks.length, 5, 'five picks in the slice');
    assertEq(new Set(picks.map(f => f.playerId)).size, 5, 'and five different players');
});

test('INIT is an opaque blob and says nothing', () => {
    assertEq(parseRoomLine(CAP[0].line, CAP[0].at), null, 'the first frame of every room');
});

test('JOINED names the reader own team, and drops the SWID with it', () => {
    const joined = capFacts.find(f => f.kind === 'joined');
    assertJson(joined, { kind: 'joined', teamId: 2, at: FIX.capture.firstFrameAt + 260 },
        'the one frame in the protocol that says which team is the reader');
    assertEq(FIX.capture.readerTeamId, 2, 'and it agrees with the capture profile');
    assertEq(JSON.stringify(joined).includes('-'), false, 'no SWID rides along');
});

test('CLOCK carries the team on the clock, and sometimes does not', () => {
    const clocks = capFacts.filter(f => f.kind === 'clock');
    assertEq(clocks.filter(c => c.teamId === null).length, 4, 'the four before the draft began');
    assertEq(clocks.filter(c => c.teamId !== null).length, 4, 'and four naming team 2 on the clock');
    assertJson(parseRoomLine('CLOCK 6 25248 2', T0),
        { kind: 'clock', seq: 6, msRemaining: 25248, teamId: 2, at: T0 }, 'a real frame, verbatim');
});

test("the fifth token on the reader own pick is discarded like the slot", () => {
    const own = parseRoomLine('SELECTED 2 4565227 10 {A1B2C3D4-0000-0000-0000-00000000E5F6}', T0);
    assertJson(own, { kind: 'selected', teamId: 2, playerId: 4565227, at: T0 },
        'the member id says nothing the team id has not, and it identifies a person');
    assertEq(JSON.stringify(own).includes('A1B2'), false, 'so it never reaches a fact');
});

test('the frames the CLIENT sends are not news', () => {
    const sent = CAP.filter(f => f.sent);
    assertEq(sent.length, 4, 'two PINGs, an AUTODRAFT and a SELECT');
    sent.forEach(f => assertEq(parseRoomLine(f.line, f.at), null, `the client wrote: ${f.line.split(' ')[0]}`));
    // The room ANSWERS both of the two that are not keepalives, and those answers are facts.
    assertEq(parseRoomLine('AUTODRAFT 2 true', T0).kind, 'autodraft', "the server's own AUTODRAFT is");
    assertEq(parseRoomLine('SELECTED 2 4565227 10', T0).kind, 'selected', 'and so is the pick that answers SELECT');
});

test('PONG carries an argument, which the transcription did not record', () => {
    assertEq(parseRoomLine('PONG PING%201790124608713', T0), null, 'still nothing to report');
    assertEq(parseRoomLine('PONG', T0), null, 'and the bare form the archive recorded reads the same');
});

test('the capture merges into a log of five real picks', () => {
    const { log, added } = applyRoomFacts(emptyLog(), capFacts);
    assertJson(log.picks.map(p => [p.overall, p.teamId, p.playerId]), [
        [1, 4, 3895074], [2, 8, 4233875], [3, 1, 3041969], [4, 7, 2563060], [5, 2, 4565227]
    ], 'the room own order, with the owner own pick fifth');
    assertEq(added.length, 5, 'all new');
    assertEq(log.picks.every(p => p.source === 'room'), true, 'every one from the room');
});

test('the status reads the capture: team 5 on the clock after five picks', () => {
    const status = roomStatus(capFacts, { teams: 10 });
    assertEq(status.picks, 5, 'five picks reported');
    assertEq(status.onClock.teamId, 5, 'the last SELECTING names team 5');
    assertEq(status.state, 1, 'STATE 1 once the draft began');
    assertEq(status.msRemaining, 30000, 'a thirty-second clock in this room');
    assertEq(status.lastPickAt, FIX.capture.firstFrameAt + 87180, "the owner own pick's arrival");
});

test('before the first SELECTING the CLOCK own team is the only source', () => {
    // The capture's opening: four CLOCK frames with no team, then the draft starts. A clock that DOES name a team, with no SELECTING yet, is the state this covers.
    const early = [parseRoomLine('CLOCK 6 25248 2', T0)];
    assertEq(roomStatus(early, { teams: 10 }).onClock.teamId, 2, 'the clock says who is up');
    assertEq(roomStatus([parseRoomLine('CLOCK 0 17731', T0)], { teams: 10 }).onClock, null,
        'and a clock with no team names nobody, rather than guessing');
});

// A connection's url, masked. Every url below is invented except its shape. No real league id and no token appears here.

test('endpointShape: the query is dropped whole, ids masked, the endpoint kept', () => {
    assertEq(endpointShape('https://fantasydraft.espn.com/game-4/league-100200300/sse/JOIN?1=a&2=b&nocache=1'),
        'fantasydraft.espn.com/game-<n>/league-<id>/sse/JOIN', 'the SSE open');
    assertEq(endpointShape('wss://fantasydraft.espn.com/game-4/league-100200300/JOIN?1=a&nocache=1'),
        'fantasydraft.espn.com/game-<n>/league-<id>/JOIN', 'the socket');
});

test('endpointShape: the two transports differ only in the sse segment', () => {
    // The finding item 1 turned on: one logical JOIN, the transport chosen by path. If these two ever stop differing by exactly that segment, the endpoint itself changed and the hook needs a look.
    const ws = endpointShape('wss://fantasydraft.espn.com/game-4/league-9/JOIN?1=a');
    const sse = endpointShape('https://fantasydraft.espn.com/game-4/league-9/sse/JOIN?1=a');
    assertEq(sse.replace('/sse/JOIN', '/JOIN'), ws, 'the same endpoint either way');
});

test('endpointShape: nothing from the query survives, whatever it holds', () => {
    const shape = endpointShape('https://h.example/game-4/league-7/sse/JOIN?1=%7BAAAAAAAA-1111-2222-3333-444444444444%7D&token=4:1:2:3:792151115');
    assertEq(shape, 'h.example/game-<n>/league-<id>/sse/JOIN', 'a token and a GUID in the query are gone');
    assertEq(shape.indexOf('792151115'), -1, 'no session code');
    assertEq(shape.indexOf('AAAA'), -1, 'no GUID');
    assertEq(shape.indexOf('?'), -1, 'no query marker at all');
});

test('endpointShape: a long path segment is a token wherever it sits', () => {
    // A path can carry the same secret a query can, so a long segment is masked and not trusted.
    assertEq(endpointShape('wss://espn.connections.edge.example/04fe8d/connection?X-Request-ID=1'),
        'espn.connections.edge.example/04fe8d/connection', 'a short segment is an endpoint name and stays');
    assertEq(endpointShape('https://h.example/AAAAAAAAAAAAAAAAAAAAAAAAAAAA/JOIN'),
        'h.example/<tok>/JOIN', 'a twenty-plus segment is masked');
});

test('endpointShape: null rather than a guess where there is no host', () => {
    assertEq(endpointShape('/game-4/league-7/sse/JOIN'), null, 'a relative url has no host to report');
    assertEq(endpointShape('JOIN'), null, 'not a url');
    assertEq(endpointShape(''), null, 'empty');
    assertEq(endpointShape(null), null, 'null');
    assertEq(endpointShape(undefined), null, 'undefined');
    assertEq(endpointShape(42), null, 'not a string');
});

test('endpointShape: the trailing and rootless forms do not throw', () => {
    assertEq(endpointShape('https://h.example'), 'h.example', 'host only');
    assertEq(endpointShape('https://h.example/'), 'h.example/', 'a bare root');
    assertEq(endpointShape('https://h.example/JOIN#frag'), 'h.example/JOIN', 'a fragment is dropped with the query');
});

// ==== The three states ====

test('roomFrameState: frames the moment any transport has delivered one', () => {
    assertEq(roomFrameState({ transports: [{ transport: 'sse', openedAt: 10, firstFrameAt: 12 }] }), 'frames', 'delivered');
    assertEq(roomFrameState({ transports: [
        { transport: 'ws', openedAt: 5, firstFrameAt: null },
        { transport: 'sse', openedAt: 10, firstFrameAt: 12 }
    ] }), 'frames', 'one of two is enough - a room that has spoken is reporting');
});

test('roomFrameState: open with nothing delivered is its OWN state', () => {
    // A connection open and silent. It must not write the same snapshot as no room at all.
    assertEq(roomFrameState({ transports: [{ transport: 'sse', openedAt: 10, firstFrameAt: null }] }),
        'open-no-frames', 'a channel opened and said nothing');
});

test('roomFrameState: none when the field is present and empty', () => {
    assertEq(roomFrameState({ transports: [] }), 'none', 'measured, and nothing opened');
});

test('roomFrameState: a snapshot from before the amendment reads frames, never silence', () => {
    // Absence of the field is absence of the MEASUREMENT. Reading an old reader's picks as "no frames yet" would put a new bug where the old one was.
    assertEq(roomFrameState({ picks: [{ overall: 1 }] }), 'frames', 'no transports field at all');
    assertEq(roomFrameState({}), 'frames', 'an empty snapshot object');
    assertEq(roomFrameState(null), 'none', 'but no snapshot at all is none');
    assertEq(roomFrameState({ transports: 'nope' }), 'frames', 'a malformed field is not a measurement either');
});

test('openTransportName: the most recently opened, since a fallback is the live channel', () => {
    assertEq(openTransportName({ transports: [
        { transport: 'ws', openedAt: 5 },
        { transport: 'sse', openedAt: 99 }
    ] }), 'sse', 'the fallback opened later and is the one to name');
    assertEq(openTransportName({ transports: [
        { transport: 'sse', openedAt: 99 },
        { transport: 'ws', openedAt: 5 }
    ] }), 'sse', 'and the array order does not decide it');
});

test('openTransportName: null rather than a guess where nothing opened', () => {
    assertEq(openTransportName({ transports: [{ transport: 'sse', openedAt: null }] }), null, 'constructed but never open');
    assertEq(openTransportName({ transports: [] }), null, 'nothing at all');
    assertEq(openTransportName({}), null, 'no field');
    assertEq(openTransportName(null), null, 'no snapshot');
});

// A partial view may only add. A reloaded room page reports only what happened since the reload, and that short list must not be numbered from pick 1. Every figure below is hand-computed in the contract.

// A log of N room picks, players 9001 upward, the shape the reader's own snapshot merges to.
function roomLogOf(n) {
    let log = emptyLog();
    for (let i = 0; i < n; i++) {
        log = applyLoggedPick(log, { teamId: 101 + (i % 6), playerId: 9001 + i });
        log.picks[log.picks.length - 1].source = 'room';
    }
    return log;
}
const SEL = (playerId, teamId) => ({ kind: 'selected', teamId: teamId ?? 101, playerId, at: T0 });

test('a reload with NO facts holds everything - an empty view adds and removes nothing', () => {
    const held = roomLogOf(45);
    const got = applyRoomFacts(held, []);
    assertEq(got.log.picks.length, 45, 'every pick still there');
    assertJson(got.log.picks.map(p => p.playerId).slice(0, 3), [9001, 9002, 9003], 'in their own order');
    assertJson([got.added.length, got.corrected.length, got.dropped.length], [0, 0, 0], 'nothing reported');
});

test('a reload with ONE fact appends at 46 and leaves 1 to 45 alone', () => {
    // THE BUG: this placed the new player at overall 1 and shifted 1..45 in behind it, then saved.
    const held = roomLogOf(45);
    const got = applyRoomFacts(held, [SEL(9500, 104)]);
    assertEq(got.log.picks.length, 46, 'one more pick');
    assertEq(got.log.picks[0].playerId, 9001, 'overall 1 is STILL the real first pick');
    assertEq(got.log.picks[44].playerId, 9045, 'and 45 is still 45');
    const last = got.log.picks[45];
    assertJson([last.overall, last.playerId, last.source], [46, 9500, 'room'], 'the new one is at 46');
    assertJson(got.added, [{ overall: 46, teamId: 104, playerId: 9500 }], 'added names 46 alone');
    assertJson([got.corrected.length, got.dropped.length], [0, 0], 'nothing corrected, nothing dropped');
});

test('a reload whose fact is already held changes nothing at all', () => {
    const held = roomLogOf(45);
    const got = applyRoomFacts(held, [SEL(9012)]);   // 9012 sits at overall 12
    assertEq(got.log.picks.length, 45, 'no duplicate');
    assertEq(got.log.picks[11].playerId, 9012, 'still at 12');
    assertJson([got.added.length, got.corrected.length, got.dropped.length], [0, 0, 0], 'deduped by player, silently and correctly');
});

test('successive post-reload facts keep landing at the right slot', () => {
    // The failure got worse with every pick, so one pick is not enough of a test.
    let log = roomLogOf(45);
    log = applyRoomFacts(log, [SEL(9500)]).log;
    log = applyRoomFacts(log, [SEL(9500), SEL(9501)]).log;
    log = applyRoomFacts(log, [SEL(9500), SEL(9501), SEL(9502)]).log;
    assertEq(log.picks.length, 48, 'three added over three merges');
    assertJson(log.picks.slice(45).map(p => [p.overall, p.playerId]), [[46, 9500], [47, 9501], [48, 9502]], 'each at its own slot');
    assertEq(log.picks[0].playerId, 9001, 'and overall 1 never moved');
});

test('the FULL room list behaves exactly as it did before', () => {
    // As long as or longer than what we hold is every case before a reload, and it must not change.
    const held = roomLogOf(3);
    const facts = [SEL(9001), SEL(9002), SEL(9003), SEL(9004)];
    const got = applyRoomFacts(held, facts);
    assertJson(got.log.picks.map(p => p.playerId), [9001, 9002, 9003, 9004], 'the room owns the prefix');
    assertJson(got.added, [{ overall: 4, teamId: 101, playerId: 9004 }], 'only the new one is added');
    assertJson([got.corrected.length, got.dropped.length], [0, 0], 'and nothing else moved');
});

test('a hand pick the room disagrees with is corrected, and counted ONCE', () => {
    let held = emptyLog();
    held = applyLoggedPick(held, { teamId: 101, playerId: 9001 });
    held.picks[0].source = 'room';
    held = applyLoggedPick(held, { teamId: 102, playerId: 9099 });   // a HAND pick at overall 2
    const got = applyRoomFacts(held, [SEL(9001), SEL(9002, 102)]);
    assertJson(got.log.picks.map(p => p.playerId), [9001, 9002], 'the room wins overall 2');
    assertJson(got.corrected, [{ overall: 2, was: 9099, now: 9002 }], 'and says so');
    // NOT ALSO IN `dropped`. Section 3's rule is that a reader reads added and corrected and counts each change once; a replacement is already reported, so recording it twice would be the noise that hides a real loss rather than a second safety net.
    assertJson(got.dropped, [], 'reported once, in corrected');
});

test('every removal is reported by one of the three lists', () => {
    // The brief asked for a rule against silent removal. There was no silent removal to fix: a held pick the result does not carry sits at an overall the result DOES reach, since the result is never shorter than the prefix, so it is reported as `corrected`'s own `was`. Asserted here so the property is held by a test rather than by an argument.
    let held = emptyLog();
    [9001, 9002, 9003, 9004, 9005].forEach(id => { held = applyLoggedPick(held, { teamId: 101, playerId: id }); });
    const got = applyRoomFacts(held, [SEL(9004), SEL(9005)]);
    const carried = new Set(got.log.picks.map(p => String(p.playerId)));
    const asDropped = new Set(got.dropped.map(d => String(d.playerId)));
    const asWas = new Set(got.corrected.map(c => String(c.was)));
    [9001, 9002, 9003, 9004, 9005].forEach(id => {
        const key = String(id);
        assertEq(carried.has(key) || asDropped.has(key) || asWas.has(key), true,
            `player ${id} is in the log, in dropped, or named as a correction's was - never nowhere`);
    });
});

// Whose connection is the room's. A second connection on the same page can drop while the draft runs on, and it must not be read as the draft ending. The endpoints below are the masked shapes endpointShape produces: A is the room and B is the other.
const A = 'fantasydraft.espn.com/game-<n>/league-<id>/JOIN';
const B = 'espn.connections.edge.example/04fe8d/connection';
const ev = (dir, endpoint, extra) => ({ lw: 'room-frame', dir, endpoint, ...(extra || {}) });

test('classifyRoomEvent: an unknown endpoint is a CANDIDATE, never the room on sight', () => {
    // A frame adopts an endpoint only once it parses. Adopting the first frame from anywhere would let another connection be taken for the room, and every real frame after it would be dropped.
    assertEq(classifyRoomEvent(null, ev('in', B)), 'unproven', 'a stranger speaking first is a candidate, not the room');
    assertEq(classifyRoomEvent(null, ev('open', A)), 'unproven', 'an open proves nothing - anything can open');
    assertEq(classifyRoomEvent(A, ev('in', A)), 'room', 'the adopted endpoint speaks for the room');
    assertEq(classifyRoomEvent(A, ev('in', B)), 'foreign', 'and a frame from anywhere else does not, so it is never parsed');
});

test('classifyRoomEvent: before any frame, NO close closes the room', () => {
    // A room that has not spoken cannot have ended.
    assertEq(classifyRoomEvent(null, ev('close', B)), 'unproven', 'a stranger closing');
    assertEq(classifyRoomEvent(null, ev('close', A)), 'unproven', 'and even the eventual room closing');
    assertEq(classifyRoomEvent(null, ev('error', B, { readyState: 2 })), 'unproven', 'nor an error');
});

test('classifyRoomEvent: once a frame has arrived, the stranger is foreign', () => {
    assertEq(classifyRoomEvent(A, ev('close', B)), 'foreign', 'the edge-connection socket closing');
    assertEq(classifyRoomEvent(A, ev('open', B)), 'foreign', 'and reconnecting');
    assertEq(classifyRoomEvent(A, ev('error', B, { readyState: 2 })), 'foreign', 'and erroring');
});

test('classifyRoomEvent: the room own close still closes it', () => {
    assertEq(classifyRoomEvent(A, ev('close', A)), 'room', 'the draft really ending');
    assertEq(classifyRoomEvent(A, ev('open', A)), 'room', 'and its own reconnect');
    assertEq(classifyRoomEvent(A, ev('error', A, { readyState: 0 })), 'room',
        'an error on the room own endpoint is the room - whether it CLOSES is the reader own rule, and a readyState of 0 does not');
});

test('classifyRoomEvent: an unparsed or missing endpoint cannot claim to be the room', () => {
    assertEq(classifyRoomEvent(A, ev('close', null)), 'foreign', 'null endpoint');
    assertEq(classifyRoomEvent(A, { lw: 'room-frame', dir: 'close' }), 'foreign', 'no endpoint field at all');
    assertEq(classifyRoomEvent(A, ev('in', null)), 'foreign', 'a frame with no endpoint cannot claim to be the room either');
    assertEq(classifyRoomEvent(A, null), 'foreign', 'and nothing at all is foreign');
});

// The grid is the anchor. The protocol carries no pick number, so an overall is derived from position, and a reader that has missed picks derives it from the wrong place. ESPN publishes the order during a live draft: every slot carries its overall, its round, its pick within the round and a real team, while every player is still the placeholder.
const GRID = FIX.grid;

test('gridOverallFor: a team pick lands at their lowest unfilled slot', () => {
    assertEq(gridOverallFor(GRID, 101, []), 1, 'team 101 opens the draft');
    assertEq(gridOverallFor(GRID, 104, []), 4, 'and 104 picks fourth');
    assertEq(gridOverallFor(GRID, 104, [4]), 5, 'the snake turns, so back-to-back');
    assertEq(gridOverallFor(GRID, 101, [1]), 8, 'and the wheel comes round');
});

test('gridOverallFor: what we already hold is what it skips', () => {
    assertEq(gridOverallFor(GRID, 102, [2]), 7, 'their first is taken, so their second');
    assertEq(gridOverallFor(GRID, 102, [2, 7]), 10, 'and then their third');
    assertEq(gridOverallFor(GRID, 102, new Set([2, 7])), 10, 'a Set reads the same as a list');
});

test('gridOverallFor: null rather than a guess when the grid cannot answer', () => {
    assertEq(gridOverallFor(GRID, 102, [2, 7, 10]), null, 'every slot of theirs is filled');
    assertEq(gridOverallFor(GRID, 999, []), null, 'a team the grid does not carry');
    assertEq(gridOverallFor([], 101, []), null, 'an empty grid');
    assertEq(gridOverallFor(null, 101, []), null, 'no grid at all');
    assertEq(gridOverallFor(GRID, null, []), null, 'no team');
});

test('gridOverallFor: the placeholder playerId is never read as filled', () => {
    // Every slot in a live grid is -1. Reading that as filled would answer null for every pick of every team; the LOG says what is filled, not the grid.
    assertEq(GRID.every(s => s.playerId === -1), true, 'the fixture is the live shape');
    assertEq(gridOverallFor(GRID, 103, []), 3, 'and a pick still places');
});


// The room's own page. Every expected value is hand-computed in the contract from the fixture's boardDom block: nine cells at overalls 1 to 9, round 2 reversed as in a snake, column 1 the reader's, the pool missing the name at overall 6, and the grid naming team 199 where column 2 maps to 102.
const BD = FIX.boardDom;
const nameLookup = (pool) => (pick) => (Object.prototype.hasOwnProperty.call(pool, pick.name) ? pool[pick.name] : null);
const columnTeam = (pick) => BD.teamIdByColumn[String(pick.column)] ?? null;

test('the board places every cell at its own overall', () => {
    const got = boardDomPicks(BD.cells, { columns: BD.columns });
    assertEq(got.columns, 3, 'columns');
    assertEq(got.rounds, 3, 'the highest round PLACED');
    assertJson(got.refused, [], 'nothing refused');
    assertJson(got.picks.map(p => p.overall), [1, 2, 3, 4, 5, 6, 7, 8, 9], 'overalls 1..9');
    assertJson(got.picks.map(p => p.column), [1, 2, 3, 3, 2, 1, 1, 2, 3], 'round 2 reversed - the page states the snake');
    assertJson(got.picks.map(p => p.pickInRound), [1, 2, 3, 1, 2, 3, 1, 2, 3], 'the pick number is ESPN\'s own');
    assertJson(got.picks.filter(p => p.mine).map(p => p.overall), [1, 6, 7], 'the reader\'s own column, by its class');
    assertEq(got.picks[0].name, 'Ada Lovel', 'the name joined and trimmed');
    assertEq(got.picks[0].proTeam, 'AAA', 'the club, the strong tie-breaker');
    assertEq(got.picks[0].position, 'C', 'and the position pill as given');
});

test('columns omitted falls back to the widest column seen', () => {
    const got = boardDomPicks(BD.cells);
    assertEq(got.columns, 3, 'the highest column, reported back so a caller can check it');
    assertJson(got.picks.map(p => p.overall), [1, 2, 3, 4, 5, 6, 7, 8, 9], 'the same overalls');
});

test('a cell that cannot be placed is refused with its reason, never guessed', () => {
    const cases = [
        ['roundDisagrees', 'round-disagrees'],
        ['pickOutOfRange', 'pick-out-of-range'],
        ['duplicateOverall', 'duplicate-overall'],
        ['noPickInRound', 'no-pick-in-round']
    ];
    cases.forEach(([key, reason]) => {
        const got = boardDomPicks([...BD.cells, BD.badCells[key]], { columns: BD.columns });
        assertEq(got.refused.length, 1, `${key}: one refusal`);
        assertEq(got.refused[0].reason, reason, `${key}: the reason`);
        assertEq(got.picks.length, 9, `${key}: the nine good cells unaffected`);
    });
    const noRound = boardDomPicks([{ pickInRound: 1, column: 1 }], { columns: 3 });
    assertEq(noRound.refused[0].reason, 'no-round', 'a cell with no round');
    assertJson(noRound.picks, [], 'and nothing placed');
});

test('the duplicate keeps the first cell in DOM order', () => {
    // badCells.duplicateOverall is round 1 pick 2 again, which is overall 2 - Bea Turing's slot.
    const got = boardDomPicks([...BD.cells, BD.badCells.duplicateOverall], { columns: BD.columns });
    assertEq(got.picks.find(p => p.overall === 2).name, 'Bea Turing', 'the first cell kept');
    assertEq(got.refused[0].cell.lastName, 'Perlis', 'the later one refused');
});

test('a cell with no name is still a placed pick', () => {
    const cells = BD.cells.slice(0, 8).concat([BD.badCells.noName]);
    const got = boardDomPicks(cells, { columns: BD.columns });
    assertEq(got.picks.length, 9, 'nine slots taken');
    assertEq(got.picks[8].name, '', 'and the ninth carries no name');
    const facts = domPickFacts(got.picks, { playerIdOf: nameLookup(BD.poolWhole), teamIdOf: columnTeam });
    assertEq(facts.facts.length, 8, 'the prefix stops before it');
    assertJson(facts.unresolved, [{ overall: 9, name: '', teamId: 103 }], 'reported, not dropped');
});

test('a whole board with every name matched is a whole log', () => {
    const board = boardDomPicks(BD.cells, { columns: BD.columns });
    const got = domPickFacts(board.picks, { playerIdOf: nameLookup(BD.poolWhole), teamIdOf: columnTeam });
    assertEq(got.facts.length, 9, 'nine facts');
    assertJson(got.held, [], 'nothing held');
    assertJson(got.unresolved, [], 'nothing unresolved');
    assertEq(got.teamSource, 'column', 'no grid given, so the header decides');
    assertJson(got.facts[0], { kind: 'selected', teamId: 101, playerId: 9001, at: null }, 'parseRoomLine\'s own shape, at null');
    // And it merges through the unchanged path, the overalls matching the board's own.
    const merged = applyRoomFacts(emptyLog(), got.facts, {});
    assertEq(merged.log.picks.length, 9, 'nine picks in the log');
    assertJson(merged.log.picks.map(p => p.overall), [1, 2, 3, 4, 5, 6, 7, 8, 9], 'position equals the board\'s overall');
    assertJson(merged.log.picks.map(p => p.playerId), [9001, 9002, 9003, 9004, 9005, 9006, 9007, 9008, 9009], 'in the board\'s order');
});

test('an unresolved name stops the prefix and everything after it is HELD', () => {
    const board = boardDomPicks(BD.cells, { columns: BD.columns });
    const got = domPickFacts(board.picks, { playerIdOf: nameLookup(BD.pool), teamIdOf: columnTeam });
    assertJson(got.facts.map(f => f.playerId), [9001, 9002, 9003, 9004, 9005], 'the contiguous run from overall 1');
    assertJson(got.unresolved, [{ overall: 6, name: 'Fay Dijkst', teamId: 101 }], 'the hole, named');
    assertJson(got.held, [
        { overall: 7, teamId: 101, playerId: 9007 },
        { overall: 8, teamId: 102, playerId: 9008 },
        { overall: 9, teamId: 103, playerId: 9009 }
    ], 'held with their own overalls - a held pick is still a taken player');
    // THE POINT OF THE PREFIX: merging held picks by position would place 9007 at overall 6.
    const merged = applyRoomFacts(emptyLog(), got.facts, {});
    assertEq(merged.log.picks.length, 5, 'only the prefix reaches the log');
});

test('the taken set reads facts and held alike', () => {
    const board = boardDomPicks(BD.cells, { columns: BD.columns });
    const got = domPickFacts(board.picks, { playerIdOf: nameLookup(BD.pool), teamIdOf: columnTeam });
    const taken = new Set([...got.facts, ...got.held].map(row => String(row.playerId)));
    assertEq(taken.size, 8, 'eight players are off the board, log or no log');
    assertEq(taken.has('9007'), true, 'a held pick is not available');
    assertEq(taken.has('9006'), false, 'and the unresolved one cannot be claimed either way');
});

test('the grid owns the team, the column is the fallback, a disagreement is reported', () => {
    const board = boardDomPicks(BD.cells, { columns: BD.columns });
    const got = domPickFacts(board.picks, {
        playerIdOf: nameLookup(BD.poolWhole),
        teamIdOf: columnTeam,
        grid: BD.grid.slots
    });
    assertEq(got.teamSource, 'grid', 'the grid is whole, so it decides');
    assertJson(got.teamMismatches, [{ overall: 5, grid: 199, column: 102 }], 'one disagreement, reported not resolved');
    assertEq(got.facts[4].teamId, 199, 'and the grid\'s answer is the one carried');
    assertEq(got.facts[0].teamId, 101, 'where they agree, nothing changes');
});

test('a holed grid is not half-trusted - the column decides for every pick', () => {
    const holed = BD.grid.slots.filter(s => s.overallPickNumber !== 5);
    const board = boardDomPicks(BD.cells, { columns: BD.columns });
    const got = domPickFacts(board.picks, { playerIdOf: nameLookup(BD.poolWhole), teamIdOf: columnTeam, grid: holed });
    assertEq(got.teamSource, 'column', 'a grid with a hole is no grid');
    assertJson(got.teamMismatches, [], 'and nothing to disagree with');
    assertEq(got.facts[4].teamId, 102, 'overall 5 reads the column\'s own team');
    const noTeam = BD.grid.slots.map(s => (s.overallPickNumber === 3 ? { ...s, teamId: null } : s));
    assertEq(domPickFacts(board.picks, { playerIdOf: nameLookup(BD.poolWhole), teamIdOf: columnTeam, grid: noTeam }).teamSource, 'column', 'a slot with no team');
});

test('no lookups at all: no facts, and every pick unresolved', () => {
    const board = boardDomPicks(BD.cells, { columns: BD.columns });
    const got = domPickFacts(board.picks);
    assertJson(got.facts, [], 'a name is not a fact');
    assertEq(got.unresolved.length, 9, 'all nine reported');
    assertEq(got.unresolved[0].teamId, null, 'with no team either');
    assertEq(got.teamSource, 'none', 'and nothing to source a team from');
    const noTeamFn = domPickFacts(board.picks, { playerIdOf: nameLookup(BD.poolWhole) });
    assertEq(noTeamFn.facts.length, 9, 'a team is not needed for a fact');
    assertJson(noTeamFn.facts.map(f => f.teamId), [null, null, null, null, null, null, null, null, null], 'null throughout, which applyRoomFacts accepts');
    assertEq(applyRoomFacts(emptyLog(), noTeamFn.facts, {}).log.picks.length, 9, 'and merges');
});

test('the empty and broken shapes', () => {
    assertJson(boardDomPicks([]), { columns: 0, rounds: 0, picks: [], refused: [] }, 'no cells');
    assertJson(boardDomPicks(null), { columns: 0, rounds: 0, picks: [], refused: [] }, 'not an array');
    assertJson(boardDomPicks([null, undefined], { columns: 3 }).picks, [], 'empty cells are not refusals either');
    assertJson(domPickFacts(null), { facts: [], unresolved: [], held: [], teamMismatches: [], teamSource: 'none' }, 'no picks');
    assertJson(domPickFacts([{ name: 'Ada Lovel' }], { playerIdOf: nameLookup(BD.poolWhole) }).facts, [], 'a pick with no overall is no pick');
    assertJson(domPickFacts(board => board), { facts: [], unresolved: [], held: [], teamMismatches: [], teamSource: 'none' }, 'not an array either');
});

test('a placeholder id from a lookup is not a match', () => {
    const board = boardDomPicks(BD.cells, { columns: BD.columns });
    const got = domPickFacts(board.picks, { playerIdOf: (p) => (p.overall === 1 ? -1 : nameLookup(BD.poolWhole)(p)), teamIdOf: columnTeam });
    assertJson(got.facts, [], 'the -1 placeholder is never read as a player, here as everywhere');
    assertEq(got.unresolved[0].overall, 1, 'reported as the hole it is');
    assertEq(got.held.length, 8, 'and the rest held');
});

// The snapshot as a diagnostic kind. Expected values are hand-computed in the contract from the fixture's snapshotExport block: two connections, one that opened, errored and never delivered a frame and one that carried the room; two picks; and four unknown frames, among them a sign-in line carrying an invented id, a keep-alive and a JSON envelope.
const SNAP = FIX.snapshotExport;

test('a frame is exported as its shape and never its text', () => {
    assertEq(redactFrameData(SNAP.snapshot.unknownFrames[0].data),
        'TOKEN <n>:<n>:<n>:{<guid>}:<n>', 'TOKEN: the verb kept, every id and the SWID gone');
    assertEq(redactFrameData('PING'), 'PING', 'a bare verb is already a shape');
    assertEq(redactFrameData(SNAP.snapshot.unknownFrames[2].data),
        'json:{type,swid,playerId}', 'a JSON envelope: its KEYS are the finding, its values never');
    assertEq(redactFrameData(SNAP.snapshot.unknownFrames[3].data),
        'WELCOME <tok> <n> <word>', 'a long field is a token wherever it sits');
    assertEq(redactFrameData('{"broken":'), 'json-like:unparsed', 'an envelope that will not parse');
    assertEq(redactFrameData('[1,2,3]'), 'json:array(3)', 'an array says its length only');
    assertEq(redactFrameData('selected 4 9001'), '<word> <n> <n>', 'a lower-case first word is not a verb');
    assertEq(redactFrameData(''), '', 'nothing in, nothing out');
    assertEq(redactFrameData(null), '', 'and no throw on a missing frame');
});

test('no GUID, token or raw frame text survives the export', () => {
    const got = roomSnapshotExport(SNAP.snapshot, { loaded: SNAP.loadedSame, now: 1790124710000 });
    const text = JSON.stringify(got);
    assertEq(/A1B2C3D4/.test(text), false, 'the invented SWID is not in the export');
    assertEq(/abcdefghijklmnop/.test(text), false, 'nor the long token');
    assertEq(/"data"/.test(text), false, 'and no frame carries a data field at all');
    assertEq(got.unknownFrames.length, 4, 'all four frames still reported');
    assertEq(got.unknownFrames[0].chars, 66, 'with the length of what was seen');
    assertEq(got.unknownFrames[0].shape, 'TOKEN <n>:<n>:<n>:{<guid>}:<n>', 'as a shape');
});

test('the snapshot export says where the room was and what it did', () => {
    const got = roomSnapshotExport(SNAP.snapshot, { loaded: SNAP.loadedSame, now: 1790124710000 });
    assertEq(got.status, 'open', 'status');
    assertEq(got.at, 1790124707829, 'the moment it was written');
    assertEq(got.ageMs, 2171, 'how old it was when the zip was built');
    assertEq(got.stale, false, 'and whether that is stale');
    assertEq(got.frameState, 'frames', 'the same three-state answer the strip prints');
    assertEq(got.openTransport, 'sse', 'the transport that opened most recently');
    assertJson(got.facts, { picks: 2, lastPickAt: 1790124700000, onClock: 103, msRemaining: 17731, myTeamId: 2 }, 'the facts as counts');
    assertEq(got.transports.length, 2, 'both transports, the foreign one included');
    assertJson(got.transports.map(t => [t.transport, t.isRoom, t.frames]), [['ws', false, 0], ['sse', true, 130]], 'which one was the room');
    assertEq(got.transports[0].lastReadyState, 3, 'and the readyState an error left behind');
    assertEq(/leagueId=|\?/.test(String(got.transports[1].endpoint)), false, 'the endpoint is the hook\'s masked shape');
});

test('the pick list is withheld when the snapshot is not the loaded league', () => {
    const other = roomSnapshotExport(SNAP.snapshot, { loaded: SNAP.loadedOther, now: 1790124710000 });
    assertEq(other.league.matchesLoaded, false, 'the mismatch is stated');
    assertEq(other.picks, null, 'no second league\'s draft rides in the zip');
    assertEq(other.picksWithheld, 2, 'and the count says what was held back');
    assertEq(other.league.leagueId, 4242424, 'the room\'s own ids stay - they ARE the diagnosis');
    assertEq(other.facts.picks, 2, 'as does the count of what it held');
    assertEq(other.transports.length, 2, 'and the transport story, which is the point of the kind');
    const same = roomSnapshotExport(SNAP.snapshot, { loaded: SNAP.loadedSame, now: 1790124710000 });
    assertEq(same.league.matchesLoaded, true, 'the same league matches');
    assertEq(same.picks.length, 2, 'and its picks are carried');
    assertEq(same.picksWithheld, 0, 'nothing withheld');
});

test('no loaded league is not a match, and the sport is never compared', () => {
    assertEq(roomSnapshotExport(SNAP.snapshot, { now: 1790124710000 }).picks, null, 'a caller that cannot say withholds');
    assertEq(roomSnapshotExport(SNAP.snapshot, { loaded: {}, now: 1 }).picks, null, 'an empty loaded league is no answer');
    // The room's sport is the url's own path segment and the page's is its select value, so a sport comparison would report a mismatch on every room there has ever been.
    const got = roomSnapshotExport({ ...SNAP.snapshot, sport: 'hockey' }, { loaded: { leagueId: 4242424, seasonId: 2027, sport: 'fhl' }, now: 1 });
    assertEq(got.league.matchesLoaded, true, 'hockey against fhl still matches on the ids');
    assertEq(got.league.sport, 'hockey', 'and the room\'s own spelling is reported as it is');
});

test('the snapshot shapes that carry nothing', () => {
    assertEq(roomSnapshotExport(null), null, 'no snapshot, no kind');
    assertEq(roomSnapshotExport('nope'), null, 'not an object either');
    const bare = roomSnapshotExport({}, { now: 5 });
    assertEq(bare.at, null, 'no moment');
    assertEq(bare.ageMs, null, 'so no age - never 5');
    assertJson(bare.transports, [], 'no transports');
    assertJson(bare.unknownFrames, [], 'no frames');
    assertEq(bare.frameState, 'frames', 'a pre-Amendment-2 snapshot reads frames, not silence');
    assertEq(bare.facts.picks, 0, 'and nothing logged');
    assertEq(bare.picksWithheld, 0, 'nothing to withhold');
});

// Redacted at rest. The buffer's rule is tested here as a pure function: the content script holds the state and calls bufferFrame for every frame that did not parse.

test('a frame is classified by the one vocabulary parseRoomLine already has', () => {
    assertEq(roomFrameClass('SELECTED 4 9001 3').kind, 'fact', 'a pick is a fact');
    assertEq(roomFrameClass('CLOCK 6 17731 4').kind, 'fact', 'so is a clock');
    ['TOKEN 4:1:2:{A1B2C3D4-0000-0000-0000-00000000E5F6}:7', 'INIT AAAA', 'PING', 'PONG', 'AUTOSUGGEST 2563060', 'SELECT 9001']
        .forEach(line => assertEq(roomFrameClass(line).kind, 'not-news', line.split(' ')[0] + ' is not news'));
    // A VERB THE PARSER KNOWS AND COULD NOT READ IS NEWS: a protocol change or a truncation, which is exactly what a diagnosis needs to see.
    assertEq(roomFrameClass('SELECTED 4').kind, 'unreadable', 'a pick with no player');
    assertEq(roomFrameClass('{"type":"SELECTED"}').kind, 'unreadable', 'an envelope');
    assertEq(roomFrameClass('WELCOME lobby').kind, 'unreadable', 'a verb nobody has met');
    assertEq(roomFrameClass('').kind, 'unreadable', 'nothing');
    assertEq(roomFrameClass(null).verb, null, 'and no throw');
    assertEq(roomFrameClass('ping').verb, 'PING', 'the verb is read case-insensitively, as the parser reads it');
});

test('a not-news verb is counted and never kept', () => {
    let buf = { frames: [], notNews: {} };
    const token = 'TOKEN 4:4242424:2:{A1B2C3D4-0000-0000-0000-00000000E5F6}:792151115';
    buf = bufferFrame(buf, { transport: 'sse', event: 'message', at: 5, data: token });
    buf = bufferFrame(buf, { transport: 'sse', event: 'message', at: 6, data: 'PING' });
    buf = bufferFrame(buf, { transport: 'sse', event: 'message', at: 7, data: 'PING' });
    assertJson(buf.frames, [], 'nothing of them is in the buffer at all');
    assertJson(buf.notNews, { TOKEN: 1, PING: 2 }, 'counted per verb');
    assertEq(JSON.stringify(buf).indexOf('A1B2C3D4'), -1, 'the session id rests nowhere');
});

test('anything else is kept as its shape and its length', () => {
    let buf = bufferFrame({ frames: [], notNews: {} },
        { transport: 'sse', event: 'draft', at: 9, data: '{"type":"SELECTED","swid":"{A1B2C3D4-0000-0000-0000-00000000E5F6}","playerId":9003}' });
    assertEq(buf.frames.length, 1, 'kept');
    assertEq(buf.frames[0].shape, 'json:{type,swid,playerId}', 'as a shape');
    assertEq(buf.frames[0].chars, 83, 'with the length of what arrived');
    assertEq(buf.frames[0].data, undefined, 'and no data field at all');
    assertEq(JSON.stringify(buf).indexOf('A1B2C3D4'), -1, 'the GUID inside it never rested either');
    buf = bufferFrame(buf, { transport: 'sse', at: 10, data: 'SELECTED 4' });
    assertEq(buf.frames[1].shape, 'SELECTED <n>', 'a known verb the parser could not read is kept');
    assertEq(buf.frames[1].event, null, 'an absent event reads null');
});

test('the cap holds, and the counts are not capped', () => {
    let buf = { frames: [], notNews: {} };
    for (let i = 0; i < 12; i++) buf = bufferFrame(buf, { transport: 'sse', at: i, data: 'WELCOME ' + i });
    assertEq(buf.frames.length, 8, 'eight frames, the cap unchanged');
    for (let i = 0; i < 40; i++) buf = bufferFrame(buf, { transport: 'sse', at: i, data: 'PING' });
    assertEq(buf.notNews.PING, 40, 'a count costs nothing and is not capped');
    assertEq(bufferFrame({ frames: [], notNews: {} }, null).frames.length, 0, 'no frame, no change');
    assertEq(bufferFrame(null, { data: 'PING' }).notNews.PING, 1, 'and no buffer builds one');
});

test('a snapshot an older build stored is redacted on the way out', () => {
    // The at-rest rule protects what is written from now on; a snapshot already in storage still holds its text until the next room replaces it, so the export redacts a legacy `data` as it always did.
    const legacy = {
        leagueId: 4242424, seasonId: 2027, at: 1,
        unknownFrames: [{ transport: 'sse', event: 'message', at: 2, data: 'TOKEN 4:4242424:2:{A1B2C3D4-0000-0000-0000-00000000E5F6}:7' }]
    };
    const got = roomSnapshotExport(legacy, { loaded: { leagueId: 4242424, seasonId: 2027 }, now: 3 });
    assertEq(got.unknownFrames[0].shape, 'TOKEN <n>:<n>:<n>:{<guid>}:<n>', 'redacted on the way out');
    assertEq(got.unknownFrames[0].chars, 58, 'its length reported from the text it held');
    assertEq(JSON.stringify(got).indexOf('A1B2C3D4'), -1, 'and the id does not reach the export');
    assertJson(got.notNews, [], 'an older snapshot has no counts - the absence of the measurement');
    // And a new one passes its shape straight through rather than re-redacting a shape.
    const fresh = roomSnapshotExport({
        leagueId: 1, seasonId: 2, at: 1,
        unknownFrames: [{ transport: 'sse', event: null, at: 2, shape: 'WELCOME <tok>', chars: 40 }],
        notNews: { PING: 17, TOKEN: 1 }
    }, { loaded: { leagueId: 1, seasonId: 2 }, now: 3 });
    assertEq(fresh.unknownFrames[0].shape, 'WELCOME <tok>', 'passed through');
    assertEq(fresh.unknownFrames[0].chars, 40, 'with its own length');
    assertJson(fresh.notNews, [{ verb: 'PING', count: 17 }, { verb: 'TOKEN', count: 1 }], 'the counts as rows');
});
test('an envelope keyed BY ids prints its keys as tokens, and keeps its names', () => {
    // A map of players keyed by player id: the ids would otherwise ride out as the keys.
    assertEq(redactFrameData('{"9001":{"slot":3},"9002":{"slot":4}}'), 'json:{<n>,<n>}', 'numeric keys');
    assertEq(redactFrameData('{"{A1B2C3D4-0000-0000-0000-00000000E5F6}":1}'), 'json:{{<guid>}}', 'a braced GUID key');
    assertEq(redactFrameData('{"a1b2c3d4-0000-0000-0000-00000000e5f6":1}'), 'json:{<guid>}', 'and a bare one');
    assertEq(redactFrameData('{"abcDEF0123456789xyz":1}'), 'json:{<tok>}', 'a long token with a digit in it');
    // THE REFINEMENT: a long camelCase key is a NAME, the thing the keys are kept to show. The field classifier would mask it on length alone; a key needs a digit or + / = as well.
    assertEq(redactFrameData('{"draftPickNumberForTeam":1,"type":"x"}'), 'json:{draftPickNumberForTeam,type}', 'long names kept');
    // The envelope the at-rest suite already uses is unchanged: its keys are all names.
    assertEq(redactFrameData('{"type":"SELECTED","swid":"{A1B2C3D4-0000-0000-0000-00000000E5F6}","playerId":9003}'),
        'json:{type,swid,playerId}', 'ordinary names pass through');
    assertEq(redactFrameData('{"-12":1,"team_12":2}'), 'json:{<n>,team_12}', 'a signed number is a number; a short mixed key is a name');
});

// ==== report ====
const passed = results.filter(r => r.ok).length;
const summary = document.getElementById('summary');
summary.textContent = `${passed}/${results.length} passed ${passed === results.length ? '✓' : '✗'}`;
summary.className = passed === results.length ? 'pass' : 'fail';
document.getElementById('results').innerHTML = results
    .map(r => `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `<br>&nbsp;&nbsp;${r.err}`}</div>`)
    .join('');
