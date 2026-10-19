/**
 * The data behind the category spread: one track per scored category, every team a dot on it at a
 * position from 0 to 1, with the reader's team and its nearest neighbours in that category named.
 *
 * The values arrive as arguments and are the same ones the Category Heatmap takes, so the two
 * cannot place a team on opposite sides of the reader.
 *
 * Pure, and it imports nothing. No DOM, no application state and no network.
 *
 * Contract: tests/fixtures/category-spread.md
 * Tests: tests/category-spread.test.html
 * @module category-spread
 */

// A figure is a finite number and nothing else. A null or a missing value is not ranked, since reading it as zero would hand a lower-is-better category its winner.
const isFigure = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Builds one track per scored category.
 *
 * @param {object} [args]
 * @param {Array<{id: *, label: string, inverse: boolean}>} args.categories The scored categories, with which way each runs.
 * @param {Array<{id: *, totals: Object<string, number>}>} args.teams Each team's total in every category.
 * @param {?(number|string)} [args.readerTeamId] The reader's team.
 * @returns {Array<{id: *, label: string, inverse: boolean, low: ?number, high: ?number, level: boolean, dots: Array<{teamId: *, value: number, at: number, role: ('reader'|'level'|'above'|'below'|'other')}>, missing: Array}>}
 *   One track per category: its raw low and high, whether every team is level, a dot per team
 *   with a figure, and the teams with none.
 */
export function categorySpread({ categories, teams, readerTeamId = null } = {}) {
    const cats = Array.isArray(categories) ? categories : [];
    const rows = Array.isArray(teams) ? teams : [];
    const reader = readerTeamId === null || readerTeamId === undefined ? null : String(readerTeamId);

    return cats.filter(cat => cat && cat.id !== undefined && cat.id !== null).map(cat => {
        const inverse = cat.inverse === true;
        const present = [];
        const missing = [];
        rows.forEach(team => {
            if (!team || team.id === undefined || team.id === null) return;
            const value = team.totals ? team.totals[cat.id] : undefined;
            if (isFigure(value)) present.push({ teamId: team.id, value });
            // Left off the track and counted, never drawn at zero. A missing figure at the low end would read as the worst team in the league.
            else missing.push(team.id);
        });

        const values = present.map(p => p.value);
        const low = values.length ? Math.min(...values) : null;
        const high = values.length ? Math.max(...values) : null;
        // A track on which every team is level says so: every dot sits at the middle, and nothing is divided by zero.
        const level = values.length > 0 && low === high;

        // Best at 1. A lower-is-better category is turned round here, once, so the far end is always the good end. The low and the high stay the raw smallest and largest values.
        const atOf = (v) => {
            if (level) return 0.5;
            const t = (v - low) / (high - low);
            return inverse ? 1 - t : t;
        };

        // Above and below are by this category's value, not by standing. The nearest strictly better value is above and the nearest strictly worse is below, and every team at that value is named. A team level with the reader has its own role, since it is the closest race on the track.
        const readerEntry = reader === null ? null : present.find(p => String(p.teamId) === reader);
        let aboveAt = null;
        let belowAt = null;
        if (readerEntry && !level) {
            const mine = atOf(readerEntry.value);
            present.forEach(p => {
                const at = atOf(p.value);
                if (at > mine && (aboveAt === null || at < aboveAt)) aboveAt = at;
                if (at < mine && (belowAt === null || at > belowAt)) belowAt = at;
            });
        }

        const dots = present.map(p => {
            const at = atOf(p.value);
            let role = 'other';
            if (readerEntry && String(p.teamId) === reader) role = 'reader';
            else if (readerEntry && at === atOf(readerEntry.value)) role = 'level';
            else if (aboveAt !== null && at === aboveAt) role = 'above';
            else if (belowAt !== null && at === belowAt) role = 'below';
            return { teamId: p.teamId, value: p.value, at, role };
        });

        return { id: cat.id, label: cat.label ?? String(cat.id), inverse, low, high, level, dots, missing };
    });
}
