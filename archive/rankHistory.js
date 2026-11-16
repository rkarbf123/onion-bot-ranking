'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateSnapshot } = require('./snapshot');
const RANK_WAIT_MS = 24 * 60 * 60 * 1000;

function getSeasonStatus(db, at = Date.now()) {
    const row = db.prepare("SELECT value FROM system.meta WHERE key='currentPeriod'").get();
    const period = row && JSON.parse(row.value);
    const start = Date.parse(period?.start);
    const eligibleAt = Number.isFinite(start) ? start + RANK_WAIT_MS : null;
    return { seasonId: period?.month || '2026-initial', eligibleAt,
        collecting: eligibleAt === null || !Number.isFinite(at) || at < eligibleAt };
}

function getSeasonId(db) {
    return getSeasonStatus(db).seasonId;
}

function recordRankHistory(db, at = Date.now()) {
    const { seasonId, eligibleAt, collecting } = getSeasonStatus(db, at);
    if (collecting) return;
    db.prepare(`
        INSERT INTO system.season_rank_history (season_id, user_id, best_rank, recorded_at)
        SELECT ?, user_id, ROW_NUMBER() OVER (ORDER BY ((level * (level - 1) / 2 * 100) + xp) DESC, user_id ASC), ?
        FROM users WHERE ((level * (level - 1) / 2 * 100) + xp) > 0
        ON CONFLICT(season_id, user_id) DO UPDATE SET best_rank = excluded.best_rank, recorded_at = excluded.recorded_at
        WHERE season_rank_history.recorded_at IS NULL OR season_rank_history.recorded_at < ?
            OR excluded.best_rank < season_rank_history.best_rank
    `).run(seasonId, at, eligibleAt);
}

function seedArchivedRanks(state, directory, at = Date.now()) {
    const privateDirectory = path.join(directory, 'private');
    if (!fs.existsSync(privateDirectory)) return;
    // Public rankings may omit users, so seed only from full private rankings.
    const save = state.db.prepare(`
        INSERT INTO season_rank_history(season_id, user_id, best_rank, recorded_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(season_id, user_id) DO UPDATE SET best_rank = excluded.best_rank, recorded_at = excluded.recorded_at
        WHERE season_rank_history.recorded_at IS NULL OR season_rank_history.recorded_at < ?
            OR excluded.best_rank < season_rank_history.best_rank
    `);
    for (const file of fs.readdirSync(privateDirectory).filter(name => name.endsWith('.json')).sort()) {
        let snapshot;
        try { snapshot = validateSnapshot(JSON.parse(fs.readFileSync(path.join(privateDirectory, file), 'utf8'))); }
        catch (error) { console.error(`최고 순위 기록 불러오기 실패 (${file}):`, error.message); continue; }
        const eligibleAt = Date.parse(snapshot.periodStart) + RANK_WAIT_MS;
        const recordedAt = Date.parse(snapshot.snapshotAt);
        if (recordedAt < eligibleAt || recordedAt > at) continue;
        state.db.transaction(() => {
            for (const row of snapshot.rankings) if (row.totalXp > 0) save.run(snapshot.id, row.userId, row.rank, recordedAt, eligibleAt);
        })();
    }
}

module.exports = { getSeasonId, getSeasonStatus, recordRankHistory, seedArchivedRanks, RANK_WAIT_MS };
