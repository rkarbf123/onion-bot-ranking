'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { VoiceXpManager } = require('../voice/voiceXpManager');

function fixture(t, beforeStart = () => {}) {
    const client = new EventEmitter();
    const guild = { id: 'guild', shardId: 0, available: true, voiceStates: { cache: new Map() } };
    client.guilds = { cache: new Map([[guild.id, guild]]) };
    let now = 0;let callback;let failure = null;let cleared = 0;
    const events = new Map();const attempts = [];const errors = [];
    const manager = { recordXp(event) {
        attempts.push(event);
        if (failure === 'before') throw new Error('DB unavailable');
        if (!events.has(event.id)) events.set(event.id,event);
        if (failure === 'after') { failure = null;throw new Error('reply lost'); }
        return { amount: event.amount };
    } };
    const voice = new VoiceXpManager({ client, manager, clock: () => now,
        timers: { setInterval(fn, delay) { assert.equal(delay,1000);callback=fn;return 1; },clearInterval() { cleared++; } },
        logger: { error: (...args) => errors.push(args) } });
    const change = (id,channelId,extra={}) => {
        const old = guild.voiceStates.cache.get(id) || { id,guild,channelId:null };
        const state = { id,guild,channelId,member:{user:{id,bot:false}},...extra };
        if (channelId) guild.voiceStates.cache.set(id,state);else guild.voiceStates.cache.delete(id);
        client.emit('voiceStateUpdate',old,state);
        return state;
    };
    beforeStart({ guild,change });voice.start();
    t.after(() => voice.stop());
    return { client,guild,voice,events,attempts,errors,change,
        advance(ms) { now+=ms;callback(); },setNow(at) { now=at; },fail(mode) { failure=mode; },
        xp: id => [...events.values()].filter(event=>event.userId===id).reduce((sum,event)=>sum+event.amount,0),
        get cleared() { return cleared; }
    };
}

test('voice awards exactly 20 XP for each full 60 seconds and never pays bots', t => {
    const f=fixture(t);f.change('human','one');f.change('bot','one',{member:{user:{bot:true}}});
    f.advance(59999);assert.equal(f.xp('human'),0);
    f.advance(1);assert.equal(f.xp('human'),20);assert.equal(f.xp('bot'),0);
    f.advance(60000);assert.equal(f.xp('human'),40);
    assert.ok([...f.events.values()].every(event=>event.type==='voice' && event.amount===20));
});

test('late joins, channel moves and mute changes use actual continuous connection time', t => {
    const f=fixture(t);f.advance(59000);f.change('human','one');
    f.advance(1000);assert.equal(f.xp('human'),0);
    f.advance(29000);f.change('human','two',{selfMute:true,selfDeaf:true});
    f.advance(30000);assert.equal(f.xp('human'),20);
});

test('leaving settles whole minutes and rejoining begins a new minute', t => {
    const f=fixture(t);f.change('human','one');
    f.setNow(60100);f.change('human',null);assert.equal(f.xp('human'),20);
    f.advance(600000);assert.equal(f.xp('human'),20);
    f.change('human','one');f.advance(59999);assert.equal(f.xp('human'),20);
    f.advance(1);assert.equal(f.xp('human'),40);
});

test('a brief connection does not earn XP or carry a partial minute into the next join', t => {
    const f=fixture(t);f.change('human','one');f.advance(59000);f.change('human',null);
    f.advance(1000);f.change('human','one');f.advance(59000);assert.equal(f.xp('human'),0);
    f.advance(1000);assert.equal(f.xp('human'),20);
});

test('delayed timers catch up complete minutes and preserve the partial remainder', t => {
    const f=fixture(t);f.change('human','one');f.advance(180500);
    assert.equal(f.xp('human'),60);assert.equal([...f.events.values()][0].at,180500);
    f.advance(59499);assert.equal(f.xp('human'),60);f.advance(1);assert.equal(f.xp('human'),80);
});

test('a lost result retries the same event before paying any newer minutes', t => {
    const f=fixture(t);f.change('human','one');f.fail('after');f.advance(60000);
    assert.equal(f.xp('human'),20);f.advance(120000);assert.equal(f.xp('human'),60);
    assert.equal(f.attempts[0].id,f.attempts[1].id);assert.equal(f.events.size,2);
});

test('a failed payout remains retryable after leaving and does not overlap a new session', t => {
    const f=fixture(t);f.change('human','one');f.fail('before');f.advance(60000);
    f.setNow(61000);f.change('human',null);assert.equal(f.xp('human'),0);
    f.setNow(62000);f.change('human','one');f.fail(null);f.advance(60000);
    assert.equal(f.xp('human'),40);assert.equal(f.events.size,2);
});

test('existing voice users start counting at bot startup and offline time earns nothing', t => {
    const f=fixture(t,({change})=>{ change('human','one'); });
    f.advance(30000);f.client.emit('shardDisconnect',{},0);f.advance(600000);
    assert.equal(f.xp('human'),0);
    f.client.emit('shardResume',0);f.advance(59999);assert.equal(f.xp('human'),0);
    f.advance(1);assert.equal(f.xp('human'),20);
});

test('unavailable guilds pause accounting and stop removes listeners and flushes elapsed minutes', t => {
    const f=fixture(t);f.change('human','one');f.advance(30000);
    f.guild.available=false;f.client.emit('guildUnavailable',f.guild);f.advance(30000);assert.equal(f.xp('human'),0);
    f.guild.available=true;f.client.emit('guildAvailable',f.guild);f.setNow(120000);f.voice.stop();
    assert.equal(f.xp('human'),20);assert.equal(f.cleared,1);assert.equal(f.client.listenerCount('voiceStateUpdate'),0);
    f.advance(600000);assert.equal(f.xp('human'),20);
});
