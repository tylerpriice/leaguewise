/**
 * The current season's head-to-head series, by team id. history.js already works out each pair's
 * record from the season's played schedule: regular season only, with the postseason counted
 * apart. This module calls it once and turns its franchise keys back into team ids. It counts no
 * wins of its own.
 *
 * Pure. No DOM, no application state and no network.
 *
 * Contract: tests/fixtures/h2h-series.md
 * Tests: tests/h2h-series.test.html
 * @module h2h-series
 */

import { summarizeSeason, headToHead } from './history.js';

const key = id => String(id);

/**
 * The current season's pairs, by team id. A roto league has no matchup schedule and returns
 * nothing.
 *
 * @param {object} payload The season's league payload.
 * @returns {Array<{aTeamId: string, bTeamId: string, aWins: number, bWins: number, ties: number}>} One entry per pair that met.
 */
export function h2hSeriesFor(payload) {
    const summary = summarizeSeason(payload);
    if (!summary || !summary.countsTowardRecords) return [];
    const pairs = headToHead([summary], { [summary.year]: payload });
    const teamIdOf = new Map(summary.franchises.map(f => [f.key, f.teamId]));
    return pairs
        .map(p => {
            const aTeamId = teamIdOf.get(p.a);
            const bTeamId = teamIdOf.get(p.b);
            if (aTeamId === undefined || bTeamId === undefined) return null;
            return { aTeamId: key(aTeamId), bTeamId: key(bTeamId), aWins: p.aWins, bWins: p.bWins, ties: p.ties };
        })
        .filter(Boolean);
}

/**
 * One team's own record against one other, read from that team's side whichever side of the
 * pair it is stored on.
 *
 * @param {object[]} series The pairs from h2hSeriesFor.
 * @param {number|string} teamId The team whose record this is.
 * @param {number|string} otherId The opponent.
 * @returns {?{wins: number, losses: number, ties: number}} The record, or null when the two have not met or are the same team.
 */
export function h2hCellFor(series, teamId, otherId) {
    const mine = key(teamId), theirs = key(otherId);
    if (mine === theirs) return null;
    const row = (series || []).find(c =>
        (c.aTeamId === mine && c.bTeamId === theirs) || (c.aTeamId === theirs && c.bTeamId === mine));
    if (!row) return null;
    const isA = row.aTeamId === mine;
    return { wins: isA ? row.aWins : row.bWins, losses: isA ? row.bWins : row.aWins, ties: row.ties };
}
