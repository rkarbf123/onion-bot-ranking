const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, AttachmentBuilder } = require('discord.js');
const { getProfileData, renderProfile } = require('./profile');
const { XP_ADMIN_ID } = require('./archive/xpEvents');

// 관리 계정 id
const ADMIN_IDS = [XP_ADMIN_ID];


module.exports = [
    {
        data: new SlashCommandBuilder()
            .setName('도움말')
            .setDescription('양파봇의 모든 명령어와 이용 방법을 확인합니다.'),
        async execute(interaction) {
            const helpEmbed = new EmbedBuilder()
                .setColor('#00FF7F')
                .setTitle('🧅 양파봇 이용 가이드')
                .setDescription(
                    `📊 \`/경험치\` : 내 레벨과 경험치 확인\n` +
                    `🪪 \`/프로필\` : 내 프로필 카드와 최고·현재 순위 확인\n` +
                    `🏆 \`/랭킹\` : 전체 순위 확인\n` +
                    `🔔 **선착순 퀴즈** : 문제를 맞히고 보너스 XP 획득` +
                    (interaction.user.id === XP_ADMIN_ID ? `\n🛠️ \`/xp\` : 사용자 경험치 추가·차감` : '')
                )
                .setFooter({ text: '이용해주셔서 감사합니다.' });
            await interaction.reply({ embeds: [helpEmbed], ephemeral: true });
        }
    },
    {
        data: new SlashCommandBuilder()
            .setName('프로필')
            .setDescription('프로필 카드에서 내 최고 순위와 현재 순위를 확인합니다.'),
        async execute(interaction, db, { manager } = {}) {
            await interaction.deferReply();
            try {
                const data = getProfileData(db, interaction.user.id, manager?.clock() ?? Date.now());
                const member = interaction.member;
                const image = await renderProfile({
                    ...data,
                    displayName: member?.displayName || member?.nick || interaction.user.globalName || interaction.user.username,
                    avatarUrl: (member?.displayAvatarURL ? member : interaction.user).displayAvatarURL({ extension: 'png', size: 256 })
                });
                await interaction.editReply({ files: [new AttachmentBuilder(image, { name: 'profile.png' })] });
            } catch (error) {
                console.error('프로필 생성 실패:', error.message);
                await interaction.editReply({ content: '프로필을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.' });
            }
        }
    },
    {
        data: new SlashCommandBuilder()
            .setName('경험치')
            .setDescription('내 레벨과 경험치를 확인합니다.'),
        async execute(interaction, db) {
            const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(interaction.user.id);
            if (!user) return interaction.reply({ content: '📊 기록이 없습니다.', ephemeral: true });

            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle(`📊 ${interaction.user.username}님의 정보`)
                .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                .addFields(
                    { name: '레벨', value: `Lv. ${user.level}`, inline: true },
                    { name: '경험치', value: `${user.xp.toLocaleString()} XP`, inline: true }
                );

            const nextXp = user.level * 100;
            const percent = Math.min(Math.floor((user.xp / nextXp) * 100), 100);
            const bar = "█".repeat(Math.round(percent / 7)) + "░".repeat(15 - Math.round(percent / 7));
            embed.addFields({ name: `진행도 (${percent}%)`, value: `\`${bar}\` \n**${user.xp}** / **${nextXp} XP**` });
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    },
    {
        data: new SlashCommandBuilder()
            .setName('xp')
            .setDescription('지정된 관리 계정만 사용자 경험치를 추가하거나 차감합니다.')
            .addUserOption(option => option.setName('대상').setDescription('경험치를 조정할 사용자').setRequired(true))
            .addStringOption(option => option.setName('작업').setDescription('추가 또는 차감').setRequired(true)
                .addChoices({ name: '추가', value: 'add' }, { name: '차감', value: 'remove' }))
            .addIntegerOption(option => option.setName('수량').setDescription('추가하거나 차감할 XP 수량').setRequired(true)
                .setMinValue(1).setMaxValue(Number.MAX_SAFE_INTEGER)),
        async execute(interaction, db, { manager } = {}) {
            if (interaction.user.id !== XP_ADMIN_ID) return interaction.reply({ content: '❌ XP 조정 권한이 없습니다.', ephemeral: true });
            const target = interaction.options.getUser('대상');
            const operation = interaction.options.getString('작업');
            const quantity = interaction.options.getInteger('수량');
            if (!target || !['add', 'remove'].includes(operation) || !Number.isSafeInteger(quantity) || quantity <= 0) {
                return interaction.reply({ content: '❌ 대상, 작업 및 1 이상의 정수 수량을 지정해주세요.', ephemeral: true });
            }
            await interaction.deferReply({ ephemeral: true });
            try {
                const result = manager.adjustXp({ id: `admin-xp:${interaction.id}`, userId: target.id,
                    actorId: interaction.user.id, amount: operation === 'add' ? quantity : -quantity, at: Date.now() });
                if (result.rejected) return interaction.editReply({ content: `❌ ${result.rejected}` });
                const change = `${result.amount >= 0 ? '+' : ''}${result.amount.toLocaleString()} XP`;
                const embed = new EmbedBuilder().setColor('#5865F2').setTitle('경험치 조정 완료')
                    .setDescription(`<@${target.id}>님의 경험치를 조정했습니다.`)
                    .addFields({ name: '변경량', value: change, inline: true },
                        { name: '총 경험치', value: `${result.totalXp.toLocaleString()} XP`, inline: true },
                        { name: '레벨', value: `Lv. ${result.level}`, inline: true });
                await interaction.editReply({ embeds: [embed] });
            } catch (error) {
                console.error('XP 조정 보류:', error.message);
                await interaction.editReply({ content: '❌ XP 변경 처리가 보류되었습니다. 관리자 로그를 확인해주세요.' });
            }
        }
    },
    {
        data: new SlashCommandBuilder()
            .setName('랭킹')
            .setDescription('서버 전체 경험치 순위를 확인합니다.'),
        async execute(interaction, db) {
            // 1. 상위 10명 가져오기
            const topQuery = 'SELECT *, ((level * (level - 1) / 2 * 100) + xp) as total_asset FROM users ORDER BY total_asset DESC LIMIT 10';
            const topUsers = db.prepare(topQuery).all();
            
            // 2. 내 순위 계산하기
            const allUsersQuery = 'SELECT user_id, ((level * (level - 1) / 2 * 100) + xp) as total_asset FROM users ORDER BY total_asset DESC';
            const allUsers = db.prepare(allUsersQuery).all();
            const myRankIndex = allUsers.findIndex(u => u.user_id === interaction.user.id);
            const myRankText = myRankIndex !== -1 ? `${myRankIndex + 1}위` : "순위 외";

            const embed = new EmbedBuilder()
                .setColor('#F1C40F')
                .setTitle('🏆 전체 랭킹 TOP 10');

            const desc = topUsers.map((row, i) => {
                const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
                const totalAsset = ((row.level * (row.level - 1)) / 2 * 100) + row.xp;
                return `${medal} <@${row.user_id}> — **${totalAsset.toLocaleString()} XP** (Lv.${row.level})`;
            }).join('\n') || "데이터가 없습니다.";

            embed.setDescription(desc);
            
            // 3. 내 순위 필드 추가
            embed.addFields({ name: '👤 내 순위', value: `현재 **${interaction.user.username}**님은 **${myRankText}**입니다.`, inline: false });

            await interaction.reply({ embeds: [embed] });
        }
    },
    {
        data: new SlashCommandBuilder()
            .setName('퀴즈설정')
            .setDescription('[관리자] 퀴즈 보상 모드 설정')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addStringOption(option => 
                option.setName('모드').setDescription('모드 선택').setRequired(true)
                    .addChoices({ name: '랜덤', value: 'RANDOM' }, { name: '1.1배', value: '1.1' }, { name: '1.2배', value: '1.2' })),
        async execute(interaction, db) {
            if (!ADMIN_IDS.includes(interaction.user.id)) return interaction.reply({ content: '❌ 권한 없음', ephemeral: true });
            const mode = interaction.options.getString('모드');
            db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?').run('quiz_reward_mode', mode, mode);
            await interaction.reply({ content: `✅ 모드가 \`${mode}\`로 변경되었습니다.`, ephemeral: true });
        }
    }
];
