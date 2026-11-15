'use strict';
function rewardAmount(user, mode, random = Math.random) {
    return mode === 'RANDOM' ? Math.floor(random() * 401) + 100 : Math.floor(((user.level * 100) + user.xp) * (parseFloat(mode) - 1.0));
}
function applyEvent(db, event) {
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
    const mode = event.type === 'quiz' ? db.prepare("SELECT value FROM settings WHERE key='quiz_reward_mode'").get()?.value || 'RANDOM' : null;
    const amount = event.type === 'quiz' ? rewardAmount(user, mode) : event.amount;
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
module.exports = { applyEvent, rewardAmount };
