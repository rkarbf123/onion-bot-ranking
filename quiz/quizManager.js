'use strict';
const { randomUUID } = require('node:crypto');
const { rewardAmount } = require('../archive/xpEvents');

const COOLDOWN = 300000;
function generateQuestion(random = Math.random) {
    const n1 = Math.floor(random() * 50) + 1;
    const n2 = Math.floor(random() * 50) + 1;
    const op = ['+', '-', '*'][Math.floor(random() * 3)];
    return { n1, n2, op, answer: op === '+' ? n1 + n2 : op === '-' ? n1 - n2 : n1 * n2 };
}
class QuizManager {
    constructor({ client, manager, state, channelId, EmbedBuilder, clock = Date.now, timers = globalThis }) {
        Object.assign(this, { client, manager, state, channelId, EmbedBuilder, clock, timers });
        this.timer = null; this.collector = null; this.busy = false; this.stopped = false;
        // Offline messages are never replayed. Only live events after this startup are eligible.
        this.onlineAt = clock();
    }
    async start() {
        if (this.stopped || this.busy || this.collector) return;
        this.busy = true;
        try {
            const channel = await this.client.channels.fetch(this.channelId);
            if(this.stopped)return;
            if (!channel?.isTextBased()) throw new Error('Quiz channel unavailable');
            let quiz = this.state.quiz();
            if (quiz?.state === 'REWARDED' && !quiz.rewarded) { this.manager.drainEvents(); quiz = this.state.quiz(); }
            if (quiz?.state === 'COOLDOWN' || quiz?.state === 'REWARDED') { this.schedule(quiz.nextQuizAt); return; }
            if (!quiz || quiz.state === 'IDLE') {
                quiz = { id: randomUUID(), ...generateQuestion(), channelId: this.channelId, state: 'ACTIVE', messageId: null,
                    createdAt: this.clock(), winnerId: null, answeredAt: null, nextQuizAt: null, rewarded: false,
                    nonce: String(BigInt(this.clock()) * 1000n + BigInt(Math.floor(Math.random() * 1000))) };
                this.state.saveQuiz(quiz);
            }
            if (quiz.channelId !== this.channelId) throw new Error('Stored quiz channel differs; restore the configured channel');
            if (quiz.messageId) {
                // Missing/deleted original messages fail closed, rather than duplicating the question.
                await channel.messages.fetch(quiz.messageId);
                if(this.stopped)return;
            } else {
                // Recover a send whose HTTP reply was lost by looking for its persisted nonce.
                let sent = null; let before;
                for (let page = 0; page < 20; page++) {
                    const history = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
                    if(this.stopped)return;
                    sent = history.find(m => m.author.id === this.client.user.id && String(m.nonce) === quiz.nonce);
                    if (sent || !history.size || history.last().createdTimestamp < quiz.createdAt) break;
                    before = history.last().id;
                }
                if (!sent) {
                    if (this.clock() - quiz.createdAt > 120000) throw new Error('Uncertain quiz send. Inspect channel and use quiz-attach/quiz-reset; no duplicate was sent.');
                    const embed = new this.EmbedBuilder().setColor('#FFA500').setTitle('🔔 퀴즈')
                        .setDescription('가장 먼저 정답을 맞히는 분께 70~100 XP를 드립니다!')
                        .addFields({ name: '📝 문제', value: `**${quiz.n1} ${quiz.op} ${quiz.n2} = ?**`, inline: true })
                        .setFooter({ text: '다음 문제가 나오기 전까지만 정답이 인정됩니다!' });
                    sent = await channel.send({ embeds: [embed], nonce: quiz.nonce, enforceNonce: true });
                    if(this.stopped)return;
                }
                quiz.messageId = sent.id; this.state.saveQuiz(quiz);
            }
            if (this.stopped) return;
            this.collector = channel.createMessageCollector({ filter: m => this.accepts(m, quiz) });
            // No time/max: stop only after a successful durable reward commit.
            this.collector.on('collect', m => {
                let result;
                try { result = this.claim(m); }
                catch (error) {
                    console.error('퀴즈 보상 보류:', error.message);
                    this.collector?.stop('pending'); this.collector = null;
                    this.timer = this.timers.setTimeout(() => { this.timer = null; void this.start(); }, 30000);
                    return;
                }
                if (!result) return;
                this.collector?.stop('rewarded'); this.collector = null;
                this.schedule(result.quiz.nextQuizAt);
                this.announce(m, channel, result).catch(error => console.error('퀴즈 알림 전송 실패:', error.message));
            });
        } catch (error) {
            if(this.stopped)return;
            console.error('퀴즈 복구 보류:', error.message);
            this.timer = this.timers.setTimeout(() => { this.timer = null; void this.start(); }, 30000);
        } finally { this.busy = false; }
    }
    accepts(message, quiz = this.state.quiz()) {
        return !!quiz && quiz.state === 'ACTIVE' && !message.author.bot && message.channelId === quiz.channelId &&
            message.createdTimestamp >= this.onlineAt && message.createdTimestamp >= quiz.createdAt &&
            !!quiz.messageId && BigInt(message.id) > BigInt(quiz.messageId) &&
            message.content.replace(/\s+/g, '') === String(quiz.answer);
    }
    claim(message) {
        // Processing time is the period boundary policy. This executes before any network await.
        const answeredAt = this.clock();
        const event = this.state.db.transaction(() => {
            const quiz = this.state.quiz();
            if (!this.accepts(message, quiz) || quiz.rewarded) return null;
            const event = { id:`quiz:${quiz.id}`, type:'quiz', quizId:quiz.id, userId:message.author.id, at:answeredAt };
            this.state.saveQuiz({ ...quiz, state:'REWARDED', winnerId:message.author.id, answeredAt,
                nextQuizAt:answeredAt + COOLDOWN, rewarded:false, answerMessageId:message.id });
            this.state.db.prepare('INSERT INTO xp_events(id,at,value) VALUES (?,?,?)').run(event.id,event.at,JSON.stringify(event));
            return event;
        })();
        return event ? this.manager.recordXp(event) : null;
    }
    schedule(at) {
        if (this.stopped) return;
        if (this.timer) this.timers.clearTimeout(this.timer);
        this.timer = this.timers.setTimeout(() => {
            this.timer = null;
            const quiz = this.state.quiz();
            if (quiz && ['COOLDOWN', 'REWARDED'].includes(quiz.state)) this.state.saveQuiz({ ...quiz, state: 'IDLE' });
            void this.start();
        }, Math.max(0, at - this.clock()));
    }
    async announce(message, channel, { rewardXp }) {
        const embed = new this.EmbedBuilder().setColor('#00FF00').setTitle('정답!')
            .setThumbnail(message.author.displayAvatarURL({ dynamic: true }))
            .setDescription(`${message.author}님이 가장 먼저 정답을 맞혔습니다!`)
            .addFields({ name: '💰 획득 경험치', value: `**+${rewardXp.toLocaleString()} XP**`, inline: true }).setTimestamp();
        await message.reply({ embeds: [embed] });
    }
    stop() { this.stopped = true; if (this.timer) this.timers.clearTimeout(this.timer); this.collector?.stop('shutdown'); this.collector = null; }
}
module.exports = { QuizManager, generateQuestion, rewardAmount, COOLDOWN };
