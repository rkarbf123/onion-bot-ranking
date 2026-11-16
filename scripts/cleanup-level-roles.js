'use strict';

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { deleteLevelRoles, LEVEL_ROLE_NAME } = require('../roles');

const apply = process.argv.includes('--apply');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const timeout = setTimeout(() => {
    console.error('Discord 연결 시간 초과');
    client.destroy();
    process.exitCode = 1;
}, 30000);

client.once('ready', async () => {
    clearTimeout(timeout);
    let deleted = 0;
    let failed = 0;
    try {
        for (const guild of client.guilds.cache.values()) {
            try {
                if (apply) {
                    const result = await deleteLevelRoles(guild);
                    deleted += result.deleted;
                    failed += result.failed;
                } else {
                    const roles = await guild.roles.fetch();
                    const matches = [...roles.values()].filter(role => LEVEL_ROLE_NAME.test(role.name));
                    console.log(JSON.stringify({ guild: guild.name, roles: matches.map(role => ({ name: role.name, editable: role.editable })) }));
                }
            } catch (error) {
                failed++;
                console.error(`[${guild.name}] 역할 정리 실패: ${error.message}`);
            }
        }
        if (apply) console.log(`삭제 완료: ${deleted}개, 실패: ${failed}개`);
        else console.log('조회 완료. 삭제하려면 --apply 옵션을 사용하세요.');
        if (failed) process.exitCode = 1;
    } finally { client.destroy(); }
});

client.login(process.env.DISCORD_TOKEN).catch(error => {
    clearTimeout(timeout);
    console.error('Discord 연결 실패:', error.message);
    client.destroy();
    process.exitCode = 1;
});
