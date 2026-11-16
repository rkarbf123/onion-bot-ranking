require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder } = require('discord.js');
const commandsList = require('./commands.js');
const path = require('node:path');
const { openRuntime } = require('./archive/archiveManager');
const GitHubUploader = require('./archive/githubUploader');
const { startScheduler } = require('./archive/scheduler');
const { QuizManager } = require('./quiz/quizManager');
const { deleteLevelRoles } = require('./roles');

const runtime = openRuntime({ names: () => Object.fromEntries(client.users.cache.map(user => [user.id, {
    username: user.username, avatarUrl: user.displayAvatarURL({ extension: 'png', size: 64 }),
    guildIds: client.guilds.cache.filter(guild => guild.members.cache.has(user.id)).map(guild => guild.id)
}])) });
const { manager, state } = runtime;
const db = manager.db;
manager.startupBackup(path.join(__dirname, 'levels_backup.db'));
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const LEVEL_CHANNEL_ID = '1467237706378514626'; 

// 기존 DB와 아카이브의 호환성을 위해 과거 컬럼을 유지합니다.
db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY, 
        xp INTEGER DEFAULT 0, 
        level INTEGER DEFAULT 1, 
        weekly_xp INTEGER DEFAULT 0,
        item1 INTEGER DEFAULT 0,
        item2 INTEGER DEFAULT 0,
        item3 INTEGER DEFAULT 0,
        item4 INTEGER DEFAULT 0,
        item5 INTEGER DEFAULT 0
    )
`).run();

const columns = ['item1', 'item2', 'item3', 'item4', 'item5'];
columns.forEach(col => {
    try { db.prepare(`ALTER TABLE users ADD COLUMN ${col} INTEGER DEFAULT 0`).run(); } catch(e) {}
});

db.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`).run();
if (!db.prepare('SELECT value FROM settings WHERE key = ?').get('quiz_reward_mode')) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('quiz_reward_mode', 'RANDOM');
}

const quiz = new QuizManager({ client, manager, state, channelId: LEVEL_CHANNEL_ID, EmbedBuilder });
manager.initializeRankHistory();
let stopArchive = async () => {};

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(process.env.APPLICATION_ID), { body: commandsList.map(c => c.data.toJSON()) });
    if (shuttingDown) return;
    console.log(`✅ ${client.user.tag} 온라인!`);
    stopArchive = startScheduler(manager, new GitHubUploader(), state);
    await quiz.start();
    for (const guild of client.guilds.cache.values()) {
        if (shuttingDown) break;
        try { await deleteLevelRoles(guild); }
        catch (error) { console.error(`[${guild.name}] 레벨 역할 조회 실패:`, error.message); }
    }
});

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    const xpToAdd = Math.min(10 + Math.floor(message.content.length / 5), 50);
    try {
        manager.recordXp({ id: `message:${message.id}`, type: 'message', userId: message.author.id,
            amount: xpToAdd, at: Date.now() });
    } catch (error) { console.error('메시지 XP 보류:', error.message); return; }
});

client.on('interactionCreate', async (i) => {
    if (!i.isChatInputCommand()) return;
    if (i.channelId !== LEVEL_CHANNEL_ID) return i.reply({ content: '❌ 양파봇 전용 채널에서 사용해주세요.', ephemeral: true });
    const cmd = commandsList.find(c => c.data.name === i.commandName);
    manager.ensurePeriod();
    if (cmd) await cmd.execute(i, db, { manager });
});

let shuttingDown = false;
async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    quiz.stop();
    client.destroy();
    await stopArchive();
    runtime.close();
    process.exitCode = 0;
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
client.login(process.env.DISCORD_TOKEN).catch(error => { console.error('Discord 로그인 실패:', error.message); void shutdown(); });
