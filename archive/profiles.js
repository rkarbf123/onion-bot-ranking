'use strict';
const fs = require('node:fs');
async function fetchProfiles(env = process.env) {
    const names = {};
    let guilds=(env.ARCHIVE_PUBLIC_GUILD_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);
    let users=(env.ARCHIVE_PUBLIC_USER_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);
    if(env.ARCHIVE_SCOPE_FILE){const scope=JSON.parse(fs.readFileSync(env.ARCHIVE_SCOPE_FILE,'utf8'));guilds=guilds.concat(scope.guildIds||[]);users=users.concat(scope.userIds||[]);}
    if (!env.DISCORD_TOKEN) {
        if(guilds.length) throw new Error('DISCORD_TOKEN is required to verify guild publication scope; explicit user IDs can be used without it');
        return names;
    }
    const { REST, Routes } = require('discord.js');
    const rest = new REST({ version:'10', timeout:15000 }).setToken(env.DISCORD_TOKEN);
    function remember(user,guildId) {
        const previous=names[user.id];
        names[user.id]={username:user.global_name||user.username,avatarUrl:user.avatar?`https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`:null,
            guildIds:[...new Set([...(previous?.guildIds||[]),...(guildId?[guildId]:[])])]};
    }
    for(const guild of new Set(guilds)) {
        let after='0';
        try {
            while(true){const members=await rest.get(Routes.guildMembers(guild),{query:new URLSearchParams({limit:'1000',after})});
                for(const m of members)remember(m.user,guild);
                if(members.length<1000)break;after=members[members.length-1].user.id;}
        } catch (_) {throw new Error(`Cannot verify publication membership for guild ${guild}; check bot member intent/access or use explicit user IDs`);}
    }
    for(const id of new Set(users)) if(!names[id]) {
        try{remember(await rest.get(Routes.user(id)));}catch(_){/* Missing names never block a ranking. */}
    }
    return names;
}
module.exports={fetchProfiles};
