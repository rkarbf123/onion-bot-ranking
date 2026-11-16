'use strict';

// Match only the retired numeric level roles; leave other role names alone.
const LEVEL_ROLE_NAME = /^LV\.\s*\d+$/i;

async function deleteLevelRoles(guild, logger = console) {
    const roles = await guild.roles.fetch();
    const result = { deleted: 0, failed: 0 };
    for (const role of roles.values()) {
        if (!LEVEL_ROLE_NAME.test(role.name)) continue;
        if (role.managed || !role.editable) {
            result.failed++;
            logger.error(`[${guild.name}] ${role.name} 삭제 불가: 역할 관리 권한과 봇 역할의 위치를 확인해주세요.`);
            continue;
        }
        try {
            await role.delete('레벨 역할 기능 종료');
            result.deleted++;
        } catch (error) {
            result.failed++;
            logger.error(`[${guild.name}] ${role.name} 삭제 실패: ${error.message}`);
        }
    }
    if (result.deleted || result.failed) logger.log(`[${guild.name}] 레벨 역할 삭제 ${result.deleted}개, 실패 ${result.failed}개`);
    return result;
}

module.exports = { deleteLevelRoles, LEVEL_ROLE_NAME };
