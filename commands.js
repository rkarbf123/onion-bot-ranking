const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');

// 관리 계정 id
const ADMIN_IDS = ['1159841882290008216']; 

const itemData = {
    'item1': { name: '🌱 양파 모종', price: 1000, reward: 10, emoji: '🌱' },
    'item2': { name: '🌿 어린 양파', price: 2000, reward: 20, emoji: '🌿' },
    'item3': { name: '🍏 덜 익은 양파', price: 5000, reward: 50, emoji: '🍏' },
    'item4': { name: '🍎 탐스러운 양파(중)', price: 7000, reward: 70, emoji: '🍎' },
    'item5': { name: '💎 탐스러운 양파(대)', price: 10000, reward: 100, emoji: '💎' }
};

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
                    `🏆 \`/랭킹\` : 전체/주간 순위 확인\n` +
                    `🏪 \`/상점\` : 아이템 구매 및 판매 (개인 전용)\n` +
                    `🔔 **선착순 퀴즈** : 문제를 맞히고 보너스 XP 획득\n` +
                    `🚜 **아이템** : 보유 아이템이 3분마다 XP 자동 생산`
                )
                .setFooter({ text: '이용해주셔서 감사합니다.' });
            await interaction.reply({ embeds: [helpEmbed], ephemeral: true });
        }
    },
    /* {
        data: new SlashCommandBuilder()
            .setName('상점')
            .setDescription('메뉴를 선택하여 아이템을 즉시 구매하거나 판매합니다.'),
        async execute(interaction, db) {
            const getUserData = () => db.prepare('SELECT * FROM users WHERE user_id = ?').get(interaction.user.id);
            let user = getUserData();
            if (!user) return interaction.reply({ content: '📊 활동 기록이 없습니다.', ephemeral: true});

            const createStoreEmbed = (userData) => {
                const totalAsset = ((userData.level * (userData.level - 1)) / 2 * 100) + userData.xp;
                return new EmbedBuilder()
                    .setColor('#00FF00')
                    .setTitle('🏪 상점')
                    .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                    .setDescription(`현재 이용 가능한 총 자산: **${totalAsset.toLocaleString()} XP**\n(부족 시 레벨이 차감되며 구매됩니다.)`)
                    .addFields(
                        { name: ` 자산 현황`, value: 
                            `총 자산: **${totalAsset.toLocaleString()} XP**\n` +
                            `현재 레벨: **Lv.${userData.level}** (잔여: ${userData.xp.toLocaleString()} XP)\n\n` +
                            `**보유 아이템:**\n🌱\`${userData.item1}\` 🌿\`${userData.item2}\` 🍏\`${userData.item3}\` 🍎\`${userData.item4}\` 💎\`${userData.item5}\``, inline: false 
                        }
                    )
                    .setFooter({ text: '거래 시 경험치량에 따라 레벨이 실시간으로 조정됩니다.' });
            };

            const buyMenu = new StringSelectMenuBuilder()
                .setCustomId('store_buy')
                .setPlaceholder('🛒 아이템 구매하기')
                .addOptions(Object.keys(itemData).map(key => ({
                    label: `${itemData[key].name} 구매`,
                    description: `가격: ${itemData[key].price} XP`,
                    value: key,
                    emoji: itemData[key].emoji
                })));

            const sellMenu = new StringSelectMenuBuilder()
                .setCustomId('store_sell')
                .setPlaceholder('💰 아이템 판매하기 (50% 환불)')
                .addOptions(Object.keys(itemData).map(key => ({
                    label: `${itemData[key].name} 판매`,
                    description: `환불: ${itemData[key].price / 2} XP`,
                    value: key,
                    emoji: itemData[key].emoji
                })));

            const row1 = new ActionRowBuilder().addComponents(buyMenu);
            const row2 = new ActionRowBuilder().addComponents(sellMenu);

            const message = await interaction.reply({ 
                embeds: [createStoreEmbed(user)], 
                components: [row1, row2],
                fetchReply: true,
                ephemeral: true
            });

            const collector = message.createMessageComponentCollector({ time: 120000 });

            collector.on('collect', async i => {
                if (i.user.id !== interaction.user.id) return i.reply({ content: '본인의 상점만 이용 가능합니다.', ephemeral: true });
                const action = i.customId; 
                const itemKey = i.values[0];
                const item = itemData[itemKey];
                let currentUser = getUserData();

                if (action === 'store_buy') {
                    let newXp = currentUser.xp - item.price;
                    let newLevel = currentUser.level;
                    while (newXp < 0 && newLevel > 1) { newLevel--; newXp += (newLevel * 100); }
                    if (newXp < 0) return i.reply({ content: '❌ 레벨을 모두 소진해도 금액이 부족합니다!', ephemeral: true });
                    db.prepare(`UPDATE users SET xp = ?, level = ?, ${itemKey} = ${itemKey} + 1 WHERE user_id = ?`).run(newXp, newLevel, i.user.id);
                } else {
                    if (currentUser[itemKey] <= 0) return i.reply({ content: '❌ 보유하신 아이템이 없습니다.', ephemeral: true });
                    const refundXp = Math.floor(item.price * 0.5);
                    let newXp = currentUser.xp + refundXp;
                    let newLevel = currentUser.level;
                    while (newXp >= newLevel * 100) { newXp -= newLevel * 100; newLevel++; }
                    db.prepare(`UPDATE users SET xp = ?, level = ?, ${itemKey} = ${itemKey} - 1 WHERE user_id = ?`).run(newXp, newLevel, i.user.id);
                }

                const updatedUser = getUserData();
                await i.update({ embeds: [createStoreEmbed(updatedUser)], components: [row1, row2] });
            });
        }
    }, */
    {
        data: new SlashCommandBuilder()
            .setName('경험치')
            .setDescription('내 상세 정보와 경험치를 확인합니다.')
            .addStringOption(option => 
                option.setName('타입').setDescription('all/week 선택').setRequired(true)
                    .addChoices({ name: '전체 (all)', value: 'all' }, { name: '주간 (week)', value: 'week' })),
        async execute(interaction, db) {
            const type = interaction.options.getString('타입');
            const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(interaction.user.id);
            if (!user) return interaction.reply({ content: '📊 기록이 없습니다.', ephemeral: true });

            const isAll = type === 'all';
            const embed = new EmbedBuilder()
                .setColor(isAll ? '#5865F2' : '#57F287')
                .setTitle(`📊 ${interaction.user.username}님의 정보`)
                .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
                .addFields(
                    { name: '레벨', value: `Lv. ${user.level}`, inline: true },
                    { name: '경험치', value: `${(isAll ? user.xp : user.weekly_xp).toLocaleString()} XP`, inline: true }
                );

            if (isAll) {
                const nextXp = user.level * 100;
                const percent = Math.min(Math.floor((user.xp / nextXp) * 100), 100);
                const bar = "█".repeat(Math.round(percent / 7)) + "░".repeat(15 - Math.round(percent / 7));
                embed.addFields(
                    { name: `진행도 (${percent}%)`, value: `\`${bar}\` \n**${user.xp}** / **${nextXp} XP**` },
                    { name: '보유 아이템', value: `🌱:${user.item1} 🌿:${user.item2} 🍏:${user.item3} 🍎:${user.item4} 💎:${user.item5}` }
                );
            }
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    },
    {
        data: new SlashCommandBuilder()
            .setName('랭킹')
            .setDescription('서버 경험치 순위를 확인합니다.')
            .addStringOption(option => 
                option.setName('타입').setDescription('all/week 선택').setRequired(true)
                    .addChoices({ name: '전체 랭킹', value: 'all' }, { name: '주간 랭킹', value: 'week' })),
        async execute(interaction, db) {
            const type = interaction.options.getString('타입');
            const isAll = type === 'all';
            
            // 1. 상위 10명 가져오기
            const topQuery = isAll 
                ? 'SELECT *, ((level * (level - 1) / 2 * 100) + xp) as total_asset FROM users ORDER BY total_asset DESC LIMIT 10' 
                : 'SELECT * FROM users WHERE weekly_xp > 0 ORDER BY weekly_xp DESC LIMIT 10';
            const topUsers = db.prepare(topQuery).all();
            
            // 2. 내 순위 계산하기
            const allUsersQuery = isAll
                ? 'SELECT user_id, ((level * (level - 1) / 2 * 100) + xp) as total_asset FROM users ORDER BY total_asset DESC'
                : 'SELECT user_id, weekly_xp FROM users WHERE weekly_xp > 0 ORDER BY weekly_xp DESC';
            const allUsers = db.prepare(allUsersQuery).all();
            const myRankIndex = allUsers.findIndex(u => u.user_id === interaction.user.id);
            const myRankText = myRankIndex !== -1 ? `${myRankIndex + 1}위` : "순위 외";

            const embed = new EmbedBuilder()
                .setColor(isAll ? '#F1C40F' : '#ADFF2F')
                .setTitle(isAll ? '🏆 전체 랭킹 TOP 10' : '📅 주간 랭킹 TOP 10');

            const desc = topUsers.map((row, i) => {
                const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
                if (isAll) {
                    const totalAsset = ((row.level * (row.level - 1)) / 2 * 100) + row.xp;
                    return `${medal} <@${row.user_id}> — **${totalAsset.toLocaleString()} XP** (Lv.${row.level})`;
                } else {
                    return `${medal} <@${row.user_id}> — **${row.weekly_xp.toLocaleString()} XP**`;
                }
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