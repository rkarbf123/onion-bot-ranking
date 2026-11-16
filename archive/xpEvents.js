'use strict';
const XP_ADMIN_ID = '1159841882290008216';

function validateAdjustment({ actorId, userId, amount }) {
    if (actorId !== XP_ADMIN_ID) throw new Error('XP 조정 권한이 없습니다.');
    if (typeof userId !== 'string' || !/^\d+$/.test(userId)) throw new Error('올바른 대상 사용자가 필요합니다.');
    if (!Number.isSafeInteger(amount) || amount === 0) throw new Error('XP 수량은 1 이상의 정수여야 합니다.');
}

function adjustXp(db, event) {
    validateAdjustment(event);
    const user = db.prepare('SELECT level,xp FROM users WHERE user_id=?').get(event.userId) || { level: 1, xp: 0 };
    const previousTotalXp = user.level * (user.level - 1) / 2 * 100 + user.xp;
    const totalXp = Math.max(0, previousTotalXp + event.amount);
    if (!Number.isSafeInteger(totalXp)) return { rejected: 'XP 수량이 처리 가능한 범위를 초과합니다.' };
    const baseXp = level => level * (level - 1) / 2 * 100;
    let level = Math.max(1, Math.floor((1 + Math.sqrt(1 + totalXp / 12.5)) / 2));
    while (baseXp(level) > totalXp) level--;
    while (baseXp(level + 1) <= totalXp) level++;
    const xp = totalXp - baseXp(level);
    db.prepare(`INSERT INTO users(user_id,level,xp) VALUES (?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET level=excluded.level,xp=excluded.xp`).run(event.userId, level, xp);
    return { amount: totalXp - previousTotalXp, previousTotalXp, totalXp, level, xp, levels: [] };
}

function rewardAmount(random = Math.random) {
    return Math.floor(random() * 31) + 70;
}
function applyEvent(db, event) {
    if (event.type === 'xpAdjustment') return adjustXp(db, event);
    if(event.type==='harvestTick') {
        const results=[];
        for(const user of db.prepare('SELECT * FROM users').all()) {
            const amount=user.item1*10+user.item2*20+user.item3*50+user.item4*70+user.item5*100;
            if(amount>0)results.push(applyEvent(db,{...event,type:'harvest',userId:user.user_id,amount}));
        }
        return {users:results.length};
    }
    db.prepare('INSERT OR IGNORE INTO users(user_id,xp,level) VALUES (?,0,1)').run(event.userId);
    const user = db.prepare('SELECT * FROM users WHERE user_id=?').get(event.userId);
    const mode = event.type === 'quiz' ? 'RANDOM' : null;
    const amount = event.type === 'quiz' ? rewardAmount() : event.amount;
    if (!Number.isSafeInteger(amount) || amount < 0 || !Number.isSafeInteger(user.level) || user.level < 1 || !Number.isSafeInteger(user.xp)) throw new Error('Invalid XP event or user data');
    let newXp = user.xp + amount; let newLevel = user.level; const levels = [];
    while (newXp >= newLevel * 100) { newXp -= newLevel * 100; newLevel++; levels.push(newLevel); }
    db.prepare('UPDATE users SET xp=?,level=? WHERE user_id=?').run(newXp,newLevel,event.userId);
    const result = { amount, levels };
    if (event.type === 'quiz') {
        const row = db.prepare('SELECT value FROM system.quiz WHERE id=1').get();
        const quiz = row && JSON.parse(row.value);
        if (!quiz || quiz.id !== event.quizId || quiz.winnerId !== event.userId || quiz.rewarded) throw new Error('Quiz reward intent differs');
        Object.assign(quiz, { state:'COOLDOWN', rewarded:true, rewardXp:amount, rewardMode:mode });
        db.prepare('UPDATE system.quiz SET value=? WHERE id=1').run(JSON.stringify(quiz));
        Object.assign(result, { quiz, rewardXp:amount, mode });
    }
    return result;
}
module.exports = { applyEvent, rewardAmount, validateAdjustment, XP_ADMIN_ID };
