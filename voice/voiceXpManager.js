'use strict';

const { randomUUID } = require('node:crypto');

const INTERVAL_MS = 60000;
const XP_PER_INTERVAL = 20;

class VoiceXpManager {
    constructor({ client, manager, clock = Date.now, timers = globalThis, logger = console }) {
        Object.assign(this, { client, manager, clock, timers, logger });
        this.active = new Map();
        this.sessions = new Map();
        this.pausedShards = new Set();
        this.running = false;
        this.timer = null;
        this.listeners = {
            voiceStateUpdate: (oldState, newState) => this.update(oldState, newState),
            shardDisconnect: (_, shardId) => this.disconnectShard(shardId),
            shardReady: shardId => this.resumeShard(shardId),
            shardResume: shardId => this.resumeShard(shardId),
            guildCreate: guild => this.seedGuild(guild),
            guildAvailable: guild => this.seedGuild(guild),
            guildDelete: guild => this.closeGuild(guild.id),
            guildUnavailable: guild => this.closeGuild(guild.id)
        };
    }

    start() {
        if (this.running) return;
        this.running = true;
        for (const [event, listener] of Object.entries(this.listeners)) this.client.on(event, listener);
        for (const guild of this.client.guilds.cache.values()) this.seedGuild(guild);
        this.timer = this.timers.setInterval(() => this.tick(), 1000);
    }

    eligible(state) {
        return !!state?.channelId && !!state.member?.user && !state.member.user.bot &&
            state.guild.available !== false && !this.pausedShards.has(state.guild.shardId);
    }

    update(oldState, newState) {
        if (!this.running) return;
        const guild = newState?.guild || oldState?.guild;
        const userId = newState?.id || oldState?.id;
        if (!guild || !userId) return;
        const key = `${guild.id}:${userId}`;
        const session = this.active.get(key);
        const at = this.clock();
        if (!this.eligible(newState)) {
            if (session) this.close(session, at);
            return;
        }
        // Moving channels or changing mute/deaf status preserves the elapsed time.
        if (session) return;
        const next = { id: randomUUID(), key, guildId: guild.id, shardId: guild.shardId,
            userId, nextAt: at + INTERVAL_MS, endedAt: null, pending: null };
        this.active.set(key, next);
        this.sessions.set(next.id, next);
    }

    seedGuild(guild) {
        if (!this.running || guild.available === false || this.pausedShards.has(guild.shardId)) return;
        for (const state of guild.voiceStates.cache.values()) this.update(null, state);
    }

    close(session, at) {
        if (session.endedAt === null) session.endedAt = at;
        if (this.active.get(session.key) === session) this.active.delete(session.key);
        this.flush(session, at);
    }

    flush(session, at) {
        const end = session.endedAt ?? at;
        while (session.pending || session.nextAt <= end) {
            if (!session.pending) {
                const count = Math.floor((end - session.nextAt) / INTERVAL_MS) + 1;
                const through = session.nextAt + (count - 1) * INTERVAL_MS;
                session.pending = { through, event: {
                    id: `voice:${session.id}:${session.nextAt}:${through}`,
                    type: 'voice', userId: session.userId, amount: count * XP_PER_INTERVAL,
                    // Season attribution follows the existing processing-time policy.
                    at
                } };
            }
            try { this.manager.recordXp(session.pending.event); }
            catch (error) { this.logger.error('음성 XP 보류:', error.message); return; }
            session.nextAt = session.pending.through + INTERVAL_MS;
            session.pending = null;
        }
        if (session.endedAt !== null) this.sessions.delete(session.id);
    }

    tick() {
        if (!this.running) return;
        const at = this.clock();
        for (const session of this.sessions.values()) {
            const guild = this.client.guilds.cache.get(session.guildId);
            const state = guild?.voiceStates.cache.get(session.userId);
            if (session.endedAt === null && !this.eligible(state)) this.close(session, at);
            else this.flush(session, at);
        }
    }

    closeGuild(guildId) {
        const at = this.clock();
        for (const session of this.active.values()) if (session.guildId === guildId) this.close(session, at);
    }

    disconnectShard(shardId) {
        this.pausedShards.add(shardId);
        const at = this.clock();
        for (const session of this.active.values()) if (session.shardId === shardId) this.close(session, at);
    }

    resumeShard(shardId) {
        if (!this.running) return;
        this.pausedShards.delete(shardId);
        for (const guild of this.client.guilds.cache.values()) if (guild.shardId === shardId) this.seedGuild(guild);
    }

    resumeShard(shardId) {
        this.pausedShards.delete(shardId);
        for (const guild of this.client.guilds.cache.values()) if (guild.shardId === shardId) this.seedGuild(guild);
    }

    stop() {
        if (!this.running) return;
        this.running = false;
        this.timers.clearInterval(this.timer);
        this.timer = null;
        for (const [event, listener] of Object.entries(this.listeners)) this.client.off(event, listener);
        const at = this.clock();
        for (const session of this.sessions.values()) this.close(session, at);
        this.pausedShards.clear();
    }
}

module.exports = { VoiceXpManager, INTERVAL_MS, XP_PER_INTERVAL };
