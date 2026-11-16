'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { Collection, EmbedBuilder } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { getProfileData, renderProfile, drawRank } = require('../profile');
const { deleteLevelRoles } = require('../roles');
const { QuizManager } = require('../quiz/quizManager');

function profileDb(t) {
    const db = new Database(':memory:');
    t.after(() => db.close());
    db.exec(`ATTACH DATABASE ':memory:' AS system;
        CREATE TABLE system.meta(key TEXT PRIMARY KEY,value TEXT);
        CREATE TABLE system.season_rank_history(season_id TEXT,user_id TEXT,best_rank INTEGER NOT NULL,recorded_at INTEGER,PRIMARY KEY(season_id,user_id))`);
    db.prepare('INSERT INTO system.meta VALUES (?,?)').run('currentPeriod',JSON.stringify({month:'2026-11',start:'2026-11-01T00:00:00+09:00'}));
    return db;
}

test('profile tracks best and current ranks with stable ties and excludes zero XP', t => {
    const db = profileDb(t);
    db.exec("CREATE TABLE users(user_id TEXT, level INTEGER, xp INTEGER); INSERT INTO users VALUES ('10',3,50), ('20',2,40), ('30',2,40)");
    assert.deepEqual(getProfileData(db, '20'), { level: 2, xp: 40, totalXp: 140, rank: 2, bestRank: 2, totalUsers: 3, collecting: false });
    assert.equal(getProfileData(db, '30').rank, 3);
    assert.equal(getProfileData(db, '10').bestRank, 1);
    assert.equal(getProfileData(db, '40').rank, null);
    assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 3);
    db.exec('DELETE FROM users');
    assert.deepEqual(getProfileData(db, '20'), { level: 1, xp: 0, totalXp: 0, rank: null, bestRank: 2, totalUsers: 0, collecting: false });
    db.exec("INSERT INTO users VALUES ('20',1,0)");
    assert.equal(getProfileData(db, '20').rank, null);
    assert.equal(getProfileData(db, '20').bestRank, 2);
});

test('profile keeps level progress available while ranks are collecting', t => {
    const db = profileDb(t);
    db.exec("CREATE TABLE users(user_id TEXT, level INTEGER, xp INTEGER); INSERT INTO users VALUES ('20',10,250)");
    const at = Date.parse('2026-11-01T12:00:00+09:00');
    assert.deepEqual(getProfileData(db, '20', at), { level: 10, xp: 250, totalXp: 4750, rank: null, bestRank: null, totalUsers: 1, collecting: true });
    assert.deepEqual(getProfileData(db, 'missing', at), { level: 1, xp: 0, totalXp: 0, rank: null, bestRank: null, totalUsers: 1, collecting: true });
});

test('profile renders the updated layout with a circular avatar and black background', async () => {
    const avatar = createCanvas(64, 64);
    avatar.getContext('2d').fillStyle = '#ff0000';
    avatar.getContext('2d').fillRect(0, 0, 64, 64);
    const png = await renderProfile({ displayName: '최예린', avatarImage: avatar, bestRank: 1, rank: 2 });
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    const img = await loadImage(png);
    assert.equal(img.width, 994); assert.equal(img.height, 316);
    const canvas = createCanvas(img.width, img.height); const ctx = canvas.getContext('2d');ctx.drawImage(img, 0, 0);
    const pixel = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
    assert.deepEqual(pixel(162, 158), [255, 0, 0, 255]);
    assert.deepEqual(pixel(32, 28), [0, 0, 0, 255]);
    assert.deepEqual(pixel(10, 10), [0, 0, 0, 255]);
    assert.deepEqual(pixel(0, 0), [0, 0, 0, 255]);
});

test('profile bar uses current-level XP over the next-level requirement and clamps its fill', async () => {
    for (const [xp, fraction] of [[0, 0], [250, 0.25], [500, 0.5], [1000, 1], [1500, 1], [-100, 0]]) {
        const image = await loadImage(await renderProfile({ displayName: '테스트', level: 10, xp }));
        const canvas = createCanvas(image.width, image.height);
        const ctx = canvas.getContext('2d');ctx.drawImage(image, 0, 0);
        for (const offset of [20, 100, 200, 300, 400, 480]) {
            const expected = offset < 508 * fraction ? [0, 243, 181, 255] : [83, 83, 83, 255];
            assert.deepEqual([...ctx.getImageData(344 + offset, 266, 1, 1).data], expected, `XP ${xp}, offset ${offset}`);
        }
        assert.deepEqual([...ctx.getImageData(860, 266, 1, 1).data], [0, 0, 0, 255]);
    }
});

test('rank numbers use the reference gradients, solid colors and white outside the top ten', () => {
    function pixels(rank) {
        const canvas = createCanvas(170, 100);const ctx = canvas.getContext('2d');drawRank(ctx, rank, 0, 50);
        const data = ctx.getImageData(0, 0, 170, 100).data;const colors = [];
        for (let i = 0; i < data.length; i += 4) if (data[i + 3] === 255) colors.push([...data.slice(i, i + 3)]);
        assert.ok(colors.length > 0);return colors;
    }
    const gold = pixels(1);
    assert.ok(gold.some(([r, g, b]) => r > 230 && g < 150 && b > 130));
    assert.ok(gold.some(([r, g, b]) => r > 230 && g > 170 && b < 130));
    for (const rank of [2, 3]) {
        const purple = pixels(rank);
        assert.ok(purple.some(([r, g, b]) => r < 140 && b > 200));
        assert.ok(purple.some(([r, g, b]) => r > 180 && b > 180));
    }
    const solid = { 4: [0, 244, 244], 5: [0, 243, 181], 6: [39, 239, 101], 7: [83, 232, 0], 8: [149, 229, 0], 9: [196, 233, 0], 10: [239, 240, 9] };
    for (const [rank, color] of Object.entries(solid)) assert.ok(pixels(Number(rank)).every(pixel => pixel.every((channel, i) => channel === color[i])));
    for (const rank of [11, 9999, null]) assert.ok(pixels(rank).every(pixel => pixel.every(channel => channel === 255)));
});

test('collecting profiles replace both rank values even when stale numbers are supplied', async () => {
    const first=await renderProfile({displayName:'test',bestRank:1,rank:2,collecting:true});
    const second=await renderProfile({displayName:'test',bestRank:10,rank:999,collecting:true});
    assert.deepEqual(first,second);
    const img=await loadImage(first);const canvas=createCanvas(img.width,img.height);
    const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);
    const highest=ctx.getImageData(524,120,148,52).data;
    const current=ctx.getImageData(524,178,148,52).data;
    assert.deepEqual(highest,current);
    assert.ok(highest.some((channel,i)=>i%4!==3 && channel===255));
});

test('profile command defers its reply and still renders if avatar download fails', async t => {
    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error('offline'); };
    t.after(() => { global.fetch = originalFetch; });
    const db = profileDb(t);
    db.exec('CREATE TABLE users(user_id TEXT, level INTEGER, xp INTEGER)');
    const replies = [];
    const command = require('../commands').find(c => c.data.name === '프로필');
    await command.execute({ user: { id: '1', username: '한글 이름'.repeat(12), displayAvatarURL: () => 'https://cdn.discordapp.com/offline.png' }, deferReply: async () => replies.push('deferred'), editReply: async reply => replies.push(reply) }, db);
    assert.equal(replies[0], 'deferred');
    assert.equal(replies[1].files[0].name, 'profile.png');
    assert.ok(Buffer.isBuffer(replies[1].files[0].attachment));
});

test('role cleanup deletes only numeric LV roles, reports blocked roles and continues after errors', async () => {
    const deleted = []; const errors = [];
    const role = (name, editable = true, fail = false) => ({ name, editable, managed: false, async delete() { if (fail) throw new Error('denied');deleted.push(name); } });
    const roles = [role('LV. 1'), role('Lv.100'), role('LV. 999', false), role('LV. 2', true, true), role('LV. 3'), role('LV. 4'), role('LV. 관리자'), role('다른 LV. 1'), role('LV. 1 보너스'), role('LVX 2')];
    roles[5].managed = true;
    const result = await deleteLevelRoles({ name: 'test', roles: { fetch: async () => new Collection(roles.map((r, i) => [String(i), r])) } }, { log() {}, error: text => errors.push(text) });
    assert.deepEqual(deleted, ['LV. 1', 'Lv.100', 'LV. 3']);
    assert.deepEqual(result, { deleted: 3, failed: 3 });
    assert.equal(errors.length, 3);
});

test('quiz announces the reward without sending level-up notifications', async () => {
    const replies = [];
    const quiz = new QuizManager({ EmbedBuilder });
    await quiz.announce({ author: { toString: () => '<@1>', displayAvatarURL: () => 'https://cdn.discordapp.com/avatar.png' }, reply: async value => replies.push(value) }, { send() { assert.fail('level-up notice sent'); } }, { rewardXp: 100, levels: [2, 3, 4] });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].embeds[0].data.title, '정답!');
});
