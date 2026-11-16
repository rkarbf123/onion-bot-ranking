'use strict';

const path = require('node:path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const { getSeasonStatus, recordRankHistory } = require('./archive/rankHistory');

GlobalFonts.registerFromPath(path.join(__dirname, 'assets/fonts/NotoSansKR.ttf'), 'Profile Korean');
const FONT = '"Profile Korean", "Malgun Gothic", sans-serif';
const RANK_COLORS = {
    1: ['#ff72b6', '#ffdb56'],
    2: ['#7563ef', '#ce69cb'],
    3: ['#7563ef', '#ce69cb'],
    4: ['#00f4f4'],
    5: ['#00f3b5'],
    6: ['#27ef65'],
    7: ['#53e800'],
    8: ['#95e500'],
    9: ['#c4e900'],
    10: ['#eff009']
};

function getProfileData(db, userId, at = Date.now()) {
    return db.transaction(() => {
        const { seasonId, eligibleAt, collecting } = getSeasonStatus(db, at);
        const user = db.prepare('SELECT level, xp FROM users WHERE user_id=?').get(userId);
        const progress = { level: user?.level ?? 1, xp: user?.xp ?? 0 };
        if (collecting) {
            const count = db.prepare('SELECT count(*) AS n FROM users WHERE ((level * (level - 1) / 2 * 100) + xp) > 0').get();
            return { ...progress, totalXp: progress.level * (progress.level - 1) / 2 * 100 + progress.xp, rank: null, bestRank: null, totalUsers: count.n, collecting: true };
        }
        recordRankHistory(db, at);
        const users = db.prepare(`
            SELECT user_id, ((level * (level - 1) / 2 * 100) + xp) AS totalXp
            FROM users WHERE ((level * (level - 1) / 2 * 100) + xp) > 0
            ORDER BY totalXp DESC, user_id ASC
        `).all();
        const index = users.findIndex(user => user.user_id === userId);
        const rank = index < 0 ? null : index + 1;
        const history = db.prepare('SELECT best_rank FROM system.season_rank_history WHERE season_id = ? AND user_id = ? AND recorded_at >= ?').get(seasonId, userId, eligibleAt);
        return { ...progress, totalXp: index < 0 ? 0 : users[index].totalXp, rank, bestRank: history?.best_rank ?? null, totalUsers: users.length, collecting: false };
    })();
}

function centeredBaseline(ctx, text, centerY) {
    const metrics = ctx.measureText(text);
    return centerY + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
}

function drawText(ctx, text, x, centerY, size, maxWidth, color = '#ffffff', align = 'left', weight = 400) {
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.font = `${weight} ${size}px ${FONT}`;
    while (size > 16 && ctx.measureText(text).width > maxWidth) ctx.font = `${weight} ${--size}px ${FONT}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, x, centeredBaseline(ctx, text, centerY), maxWidth);
}

function drawRank(ctx, rank, x, centerY, size = 70) {
    const text = rank === null || rank === undefined ? '—' : `#${rank}`;
    const colors = RANK_COLORS[rank] || ['#ffffff'];
    ctx.font = `700 ${size}px ${FONT}`;
    while (size > 16 && ctx.measureText(text).width > 148) ctx.font = `700 ${--size}px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    if (colors.length > 1) {
        const gradient = ctx.createLinearGradient(x, 0, x + ctx.measureText(text).width, 0);
        colors.forEach((color, index) => gradient.addColorStop(index / (colors.length - 1), color));
        ctx.fillStyle = gradient;
    } else ctx.fillStyle = colors[0];
    ctx.fillText(text, x, centeredBaseline(ctx, text, centerY), 148);
}

async function fetchAvatar(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Avatar HTTP ${response.status}`);
    return loadImage(Buffer.from(await response.arrayBuffer()));
}

async function renderProfile({ displayName, avatarUrl, avatarImage, bestRank, rank, collecting = false, level = 1, xp = 0 }) {
    const canvas = createCanvas(994, 316);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    let avatar = avatarImage;
    if (!avatar && avatarUrl) {
        try { avatar = await fetchAvatar(avatarUrl); }
        catch (_) { /* Keep the initial-based avatar when Discord CDN is unavailable. */ }
    }
    ctx.save();
    ctx.beginPath();
    ctx.arc(162, 158, 130, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#c5d0d8';
    ctx.fillRect(32, 28, 260, 260);
    if (avatar) {
        const side = Math.min(avatar.width, avatar.height);
        ctx.drawImage(avatar, (avatar.width - side) / 2, (avatar.height - side) / 2, side, side, 32, 28, 260, 260);
    } else drawText(ctx, Array.from(displayName || '?')[0], 162, 158, 84, 200, '#ffffff', 'center');
    ctx.restore();

    drawText(ctx, displayName || '?', 344, 78, 60, 606, '#ffffff', 'left', 700);
    drawText(ctx, '최고 순위', 344, 146, 42, 172);
    drawText(ctx, '현재 순위', 344, 204, 42, 172);
    if (collecting) {
        drawText(ctx, '집계중', 524, 146, 38, 148);
        drawText(ctx, '집계중', 524, 204, 38, 148);
    } else {
        drawRank(ctx, bestRank, 524, 146, 42);
        drawRank(ctx, rank, 524, 204, 42);
    }

    const progress = Math.max(0, Math.min(1, xp / (level * 100)));
    ctx.beginPath();
    ctx.roundRect(344, 254, 508, 24, 12);
    ctx.fillStyle = '#535353';
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = '#00f3b5';
    ctx.fillRect(344, 254, 508 * progress, 24);
    ctx.restore();
    drawText(ctx, `LV. ${level}`, 866, 266, 28, 104);
    return canvas.toBuffer('image/png');
}

module.exports = { getProfileData, renderProfile, drawRank };
