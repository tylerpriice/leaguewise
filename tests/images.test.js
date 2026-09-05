// Unit tests for the headshot/avatar helpers. Open tests/images.test.html through any static server - green means every assertion held. These are pure string functions; the URLs they build were validated by loading them (see the comment on HEADSHOT_BASE), which is a claim no unit test can make - what IS testable is that the right id gets the right URL and the wrong kind of id gets none at all.
import { headshotUrl, initialsFor, buildPlayerAvatarHtml, proTeamLogoUrl, buildProTeamLogoHtml } from '../images.js';

const results = [];
function test(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function assertEq(actual, expected, msg) {
    if (actual !== expected) throw new Error(`${msg}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// ==== headshotUrl ====

test('headshotUrl: each sport gets its own league path', () => {
    assertEq(headshotUrl('flb', 39832), 'https://a.espncdn.com/i/headshots/mlb/players/full/39832.png', 'flb');
    assertEq(headshotUrl('fhl', 3041969), 'https://a.espncdn.com/i/headshots/nhl/players/full/3041969.png', 'fhl');
    assertEq(headshotUrl('ffl', 4429795), 'https://a.espncdn.com/i/headshots/nfl/players/full/4429795.png', 'ffl');
});

test('headshotUrl: an unsupported sport or a missing id yields null, not a broken URL', () => {
    assertEq(headshotUrl('fba', 123), null, 'unsupported sport');
    assertEq(headshotUrl('ffl', null), null, 'null id');
    assertEq(headshotUrl('ffl', undefined), null, 'undefined id');
});

test('headshotUrl: a NEGATIVE id is never a person, so it gets no URL', () => {
    // Football's team defences carry negative ids - real ones from the captured pool. Requesting a headshot for one is a 404 by construction.
    assertEq(headshotUrl('ffl', -16007), null, 'a D/ST id');
    assertEq(headshotUrl('ffl', -16034), null, 'another D/ST id');
    // The rule is about the id, not the sport: no league has negative athlete ids.
    assertEq(headshotUrl('flb', -1), null, 'negative in another sport');
});

test('headshotUrl: id 0 is falsy but not negative, and is left to the URL to answer', () => {
    // Guarding on truthiness instead of `== null || < 0` would silently drop a legitimate id 0. No pool observed uses it, which is exactly why the guard should not quietly assume.
    assertEq(headshotUrl('ffl', 0), 'https://a.espncdn.com/i/headshots/nfl/players/full/0.png', 'zero');
});

// ==== initialsFor ====

test('initialsFor: first and last initial, one name, or a question mark', () => {
    assertEq(initialsFor('Jahmyr Gibbs'), 'JG', 'two names');
    assertEq(initialsFor('Texans D/ST'), 'TD', 'a team defence reads as initials too');
    assertEq(initialsFor('Ohtani'), 'O', 'single name');
    assertEq(initialsFor('Ronald Acuna Jr.'), 'RJ', 'first and LAST part, suffix included');
    assertEq(initialsFor(''), '?', 'empty');
    assertEq(initialsFor(null), '?', 'null');
});

// ==== the avatar cell ====

test('buildPlayerAvatarHtml: a human gets an img over the initials tile', () => {
    const html = buildPlayerAvatarHtml('ffl', 4429795, 'Jahmyr Gibbs');
    assert(html.includes('<img'), 'expected an img tag');
    assert(html.includes('nfl/players/full/4429795.png'), 'expected the nfl headshot URL');
    assert(html.includes('avatar-initials'), 'the tile is in the markup underneath, always');
    assert(html.includes('loading="lazy"'), 'lazy, so an unscrolled row costs nothing');
});

test('buildPlayerAvatarHtml: a D/ST produces NO img tag at all', () => {
    // The point of the negative-id guard: not a broken image that falls back, but no request.
    const html = buildPlayerAvatarHtml('ffl', -16007, 'Texans D/ST');
    assert(!html.includes('<img'), `expected no img tag, got: ${html}`);
    assert(!html.includes('espncdn'), 'and no URL of any kind');
    assert(html.includes('>TD<'), 'the initials tile is what a team gets');
});

test('buildPlayerAvatarHtml: the name is escaped into the tile', () => {
    // initialsFor takes the first letter of each part, so a crafted name reaches the markup as initials rather than text - but the escaping is what guarantees it, not that assumption.
    const html = buildPlayerAvatarHtml('ffl', -1, '<script>x</script> Bad');
    assert(!html.includes('<script'), `expected escaping, got: ${html}`);
});

// ==== proTeamLogoUrl The URL pattern itself was validated live (LAD/Ath/Wsh flb, nj fhl, kc ffl - see images.js's own comment) - what a unit test can check is that this app's own proAbbrev passes through unchanged and that a missing sport or abbreviation yields null rather than a broken URL. ====

test('proTeamLogoUrl: each sport gets its own league path, the abbreviation passed straight through', () => {
    assertEq(proTeamLogoUrl('flb', 'LAD'), 'https://a.espncdn.com/i/teamlogos/mlb/500/LAD.png', 'flb, uppercase kept as-is');
    assertEq(proTeamLogoUrl('flb', 'Ath'), 'https://a.espncdn.com/i/teamlogos/mlb/500/Ath.png', 'flb, mixed case kept as-is (no lowercasing)');
    assertEq(proTeamLogoUrl('fhl', 'NJ'), 'https://a.espncdn.com/i/teamlogos/nhl/500/NJ.png', 'fhl');
    assertEq(proTeamLogoUrl('ffl', 'KC'), 'https://a.espncdn.com/i/teamlogos/nfl/500/KC.png', 'ffl');
});

test('proTeamLogoUrl: an unsupported sport or a missing abbreviation yields null, not a broken URL', () => {
    assertEq(proTeamLogoUrl('fba', 'LAL'), null, 'unsupported sport');
    assertEq(proTeamLogoUrl('flb', null), null, 'null abbrev');
    assertEq(proTeamLogoUrl('flb', undefined), null, 'undefined abbrev');
    assertEq(proTeamLogoUrl('flb', ''), null, 'empty string abbrev');
});

test('buildProTeamLogoHtml: a mapped abbreviation gets a lazy img in its own fixed box', () => {
    const html = buildProTeamLogoHtml('flb', 'LAD');
    assert(html.includes('pro-team-logo'), 'the fixed-size box class is present');
    assert(html.includes('<img'), 'expected an img tag');
    assert(html.includes('mlb/500/LAD.png'), 'expected the mlb logo URL');
    assert(html.includes('loading="lazy"'), 'lazy, so an unscrolled row costs nothing');
});

test('buildProTeamLogoHtml: no abbreviation renders NOTHING, not an empty box - the backlog\'s own "no logo, exactly today\'s layout" rule', () => {
    assertEq(buildProTeamLogoHtml('flb', null), '', 'no proAbbrev to show');
    assertEq(buildProTeamLogoHtml('fba', 'LAL'), '', 'unsupported sport, same as the URL builder');
});

const passed = results.filter(r => r.ok).length;
document.getElementById('summary').textContent = `${passed}/${results.length} passed`;
document.getElementById('summary').className = passed === results.length ? 'pass' : 'fail';
document.getElementById('results').innerHTML = results.map(r =>
    `<div class="${r.ok ? 'pass' : 'fail'}">${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ' - ' + r.err}</div>`
).join('');
