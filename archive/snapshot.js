'use strict';
const fs = require('node:fs');
const { monthOf } = require('./utils');
function createSnapshot(db, period, { names = {}, publicOnly = false, env = process.env } = {}) {
    let ids = (env.ARCHIVE_PUBLIC_USER_IDS || '').split(',').map(s=>s.trim()).filter(Boolean);
    let guilds = (env.ARCHIVE_PUBLIC_GUILD_IDS || '').split(',').map(s=>s.trim()).filter(Boolean);
    if (env.ARCHIVE_SCOPE_FILE) {
        const scope = JSON.parse(fs.readFileSync(env.ARCHIVE_SCOPE_FILE, 'utf8'));
        ids = ids.concat(scope.userIds || []); guilds = guilds.concat(scope.guildIds || []);
    }
    const allowed = new Set(ids);
    const excluded = new Set((env.ARCHIVE_EXCLUDED_USER_IDS || '').split(',').map(s=>s.trim()).filter(Boolean));
    const rows = db.prepare('SELECT user_id,level,xp FROM users').all();
    const rankings = rows.filter(r => !publicOnly || (!excluded.has(r.user_id) && (allowed.has(r.user_id) || (names[r.user_id]?.guildIds || []).some(id => guilds.includes(id)))))
        .map(r => ({ userId: r.user_id, username: names[r.user_id]?.username || `사용자 ${r.user_id}`, avatarUrl: names[r.user_id]?.avatarUrl || null,
            level: r.level, xp: r.xp, totalXp: ((r.level * (r.level - 1)) / 2 * 100) + r.xp }))
        .sort((a, b) => b.totalXp - a.totalXp || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
        .map((r, i) => ({ rank: i + 1, ...r }));
    const month = period.id === '2026-initial' ? null : period.id;
    const result = { schemaVersion: 1, type: month ? 'monthly' : 'initial', id: period.id, month,
        title: month ? `${Number(month.slice(0, 4))}년 ${Number(month.slice(5))}월 랭킹` : '2026년 2월 18일 ~ 11월 15일 랭킹',
        periodStart: period.start, periodEnd: period.end, snapshotAt: period.snapshotAt,
        scheduledPeriodEnd: period.scheduledEnd || period.end,
        accuracy: period.accuracy || 'actual-extraction',
        partialPeriod: period.start !== `${monthOf(period.start)}-01T00:00:00+09:00` && new Date(period.start).getTime() !== new Date(`${monthOf(period.start)}-01T00:00:00+09:00`).getTime(),
        historicalCutoff: month ? null : '2026-11-16T00:00:00+09:00',
        totalUsers: rankings.length, rankings };
    validateSnapshot(result);
    return result;
}
function validateSnapshot(s) {
    if (s.schemaVersion !== 1 || !['initial', 'monthly'].includes(s.type) || !/^(\d{4}-\d{2}|2026-initial)$/.test(s.id) || !Array.isArray(s.rankings)) throw new Error('Invalid snapshot schema');
    for (const key of ['periodStart', 'periodEnd', 'snapshotAt']) if (!Number.isFinite(Date.parse(s[key]))) throw new Error(`Invalid ${key}`);
    if (Date.parse(s.periodEnd) <= Date.parse(s.periodStart) || s.totalUsers !== s.rankings.length) throw new Error('Invalid snapshot period/count');
    let last = null; const seen = new Set();
    s.rankings.forEach((r, i) => {
        if (r.rank !== i + 1 || !/^\d+$/.test(r.userId) || seen.has(r.userId) || typeof r.username !== 'string' ||
            !Number.isSafeInteger(r.level) || r.level < 1 || !Number.isSafeInteger(r.xp) || r.xp < 0 ||
            r.totalXp !== ((r.level * (r.level - 1)) / 2 * 100) + r.xp || !Number.isSafeInteger(r.totalXp) ||
            (last && (last.totalXp < r.totalXp || (last.totalXp === r.totalXp && last.userId > r.userId)))) throw new Error('Invalid ranking data/order');
        seen.add(r.userId); last = r;
    });
    return s;
}
module.exports = { createSnapshot, validateSnapshot };
