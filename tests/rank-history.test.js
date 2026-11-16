'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const StateManager = require('../archive/stateManager');
const DatabaseManager = require('../archive/databaseManager');
const { createSnapshot } = require('../archive/snapshot');
const { getProfileData } = require('../profile');
const { XP_ADMIN_ID } = require('../archive/xpEvents');

const period = { id: '2026-11', start: '2026-11-01T00:00:00+09:00', end: '2026-12-01T00:00:00+09:00', snapshotAt: '2026-12-01T00:00:00+09:00' };

function fixture(t, setup, initialTime = '2026-11-30T23:59:00+09:00') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onion-ranks-'));
    const directory = path.join(root, 'archive');const dbFile = path.join(root, 'levels.db');
    const db = new Database(dbFile);
    db.exec(`CREATE TABLE users(user_id TEXT PRIMARY KEY, level INTEGER DEFAULT 1, xp INTEGER DEFAULT 0, weekly_xp INTEGER DEFAULT 0,
        item1 INTEGER DEFAULT 0, item2 INTEGER DEFAULT 0, item3 INTEGER DEFAULT 0, item4 INTEGER DEFAULT 0, item5 INTEGER DEFAULT 0);
        CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
        INSERT INTO users(user_id,level,xp) VALUES ('10',2,20),('20',1,50),('30',1,10),('40',1,0);`);
    if (setup) setup(db, directory);
    db.close();
    let state;let manager;let now = Date.parse(initialTime);
    function start() {
        state = new StateManager(Database, path.join(directory, 'system_state.db'));
        if (!state.get('currentPeriod')) state.set('currentPeriod', { month: '2026-11', start: period.start });
        manager = new DatabaseManager({ Database, state, dbFile, directory, env: {}, clock: () => now });
    }
    start();
    t.after(() => { manager.close();state.close();fs.rmSync(root, { recursive: true, force: true }); });
    return {
        get manager() { return manager; },get state() { return state; },
        profile: id => getProfileData(manager.db,id,now),
        best: (id, season = state.get('currentPeriod').month) => state.db.prepare('SELECT best_rank FROM season_rank_history WHERE season_id=? AND user_id=?').get(season, id)?.best_rank,
        add: (id, amount, eventId) => manager.recordXp({ id: eventId, type: 'message', userId: id, amount, at: now }),
        adjust: (id, amount, eventId, actorId = XP_ADMIN_ID) => manager.adjustXp({ id: eventId, type: 'xpAdjustment', userId: id, amount, actorId, at: now }),
        setNow: at => { now = Date.parse(at); },
        restart() { manager.close();state.close();start(); }
    };
}

test('best ranks persist across restart and start fresh each season without mixing archived seasons', t => {
    const f = fixture(t);
    assert.equal(f.best('20'), 2);assert.equal(f.best('40'), undefined);
    f.add('20', 150, 'first');assert.equal(f.best('20'), 1);
    f.add('30', 400, 'second');assert.equal(f.best('20'), 1);
    assert.equal(f.profile('20').rank, 2);
    f.restart();assert.equal(f.best('20'), 1);
    f.manager.rollover(period);
    assert.equal(f.profile('20').rank, null);
    assert.equal(f.profile('20').bestRank, null);
    assert.equal(f.best('20'), undefined);assert.equal(f.best('40'), undefined);
    assert.equal(f.best('10'), undefined);assert.equal(f.best('30'), undefined);
    assert.equal(f.best('20','2026-11'), 1);
    f.setNow('2026-12-01T00:00:00+09:00');
    f.add('10',100,'new-season-first');f.add('20',10,'new-season-second');
    assert.equal(f.best('20'),undefined);
    assert.equal(f.profile('20').collecting,true);
    f.setNow('2026-12-02T00:00:00+09:00');
    assert.equal(f.profile('20').collecting,false);
    assert.equal(f.best('20'),2);
    f.restart();assert.equal(f.best('20'),2);assert.equal(f.best('20','2026-11'),1);
});

test('XP and best rank roll back together, then replay exactly once after restart', t => {
    const f = fixture(t);
    f.manager.handle.exec("CREATE TRIGGER system.reject_event BEFORE UPDATE ON xp_events WHEN NEW.applied=1 BEGIN SELECT RAISE(ABORT,'rank rollback'); END");
    assert.throws(() => f.add('20', 150, 'retry'), /rank rollback/);
    assert.equal(f.best('20'), 2);
    assert.equal(f.manager.handle.prepare("SELECT xp FROM users WHERE user_id='20'").get().xp, 50);
    f.manager.handle.exec('DROP TRIGGER system.reject_event');
    f.restart();f.manager.drainEvents();assert.equal(f.best('20'), 1);
    const before = f.profile('20').totalXp;
    f.add('20', 150, 'retry');assert.equal(f.profile('20').totalXp, before);
});

test('legacy harvest event replay records the final batch rank without transient intermediate highs', t => {
    const f = fixture(t);
    f.manager.handle.exec("UPDATE users SET item5=1 WHERE user_id='20'; UPDATE users SET item5=2 WHERE user_id='30'");
    f.manager.recordXp({ id: 'harvest', type: 'harvestTick', at: Date.parse('2026-11-30T23:59:00+09:00') });
    assert.equal(f.best('20'), 2);assert.equal(f.best('30'), 1);
});

test('startup seeds best ranks from full archived rankings and ignores public subsets', t => {
    const f = fixture(t, (db, directory) => {
        db.prepare("UPDATE users SET xp=200 WHERE user_id='20'").run();
        const full = createSnapshot(db, {...period,snapshotAt:'2026-11-30T23:59:00+09:00'});
        fs.mkdirSync(path.join(directory, 'private'), { recursive: true });
        fs.writeFileSync(path.join(directory, 'private', '2026-11.json'), JSON.stringify(full));
        db.prepare("UPDATE users SET xp=50 WHERE user_id='20'").run();
        fs.mkdirSync(path.join(directory, 'snapshots'), { recursive: true });
        const subset = createSnapshot(db, period, { publicOnly: true, env: { ARCHIVE_PUBLIC_USER_IDS: '30' } });
        fs.writeFileSync(path.join(directory, 'snapshots', '2026-11.json'), JSON.stringify(subset));
    });
    assert.equal(f.best('20'), 1);assert.equal(f.profile('20').rank, 2);
    assert.equal(f.best('30'), 3);
    f.restart();assert.equal(f.best('20'), 1);
});

test('old all-time rank records do not contaminate season records during migration', t => {
    const f = fixture(t);
    f.state.db.prepare("INSERT INTO rank_history(user_id,best_rank) VALUES ('20',1)").run();
    f.restart();assert.equal(f.best('20'),2);
    assert.equal(f.profile('20').bestRank,2);
});

test('XP adjustment rejects every other actor before creating a durable event', t => {
    const f = fixture(t);
    const count = () => f.state.db.prepare('SELECT count(*) AS n FROM xp_events').get().n;
    const before = count();
    for (const actor of ['1', '1159841882290008217', undefined]) {
        if (actor === undefined) assert.throws(() => f.manager.adjustXp({ id: 'missing-actor', userId: '20', amount: 10, at: 1 }), /권한/);
        else assert.throws(() => f.adjust('20',100,`denied-${actor}`,actor), /권한/);
    }
    assert.equal(count(),before);assert.equal(f.profile('20').totalXp,50);
});

test('XP adjustment adds, subtracts across levels, clamps to zero, and updates other season ranks', t => {
    const f = fixture(t);
    const added = f.adjust('20',300,'add');
    assert.equal(added.totalXp,350);assert.equal(added.level,3);assert.equal(added.xp,50);assert.equal(f.best('20'),1);
    const removed = f.adjust('20',-251,'remove');
    assert.equal(removed.totalXp,99);assert.equal(removed.level,1);assert.equal(removed.xp,99);assert.equal(f.best('20'),1);
    const clamped = f.adjust('20',-1000,'clamp');
    assert.equal(clamped.totalXp,0);assert.equal(clamped.level,1);assert.equal(clamped.xp,0);assert.equal(clamped.amount,-99);
    f.adjust('10',-1000,'remove-leader');assert.equal(f.best('30'),1);
    const fresh = f.adjust('50',300,'new-user');assert.equal(fresh.level,3);assert.equal(fresh.xp,0);
    assert.equal(f.adjust('50',300,'new-user').totalXp,300);
    assert.equal(f.profile('50').totalXp,300);
});

test('XP adjustment handles large counts and rejects overflow without blocking later events', t => {
    const f = fixture(t);
    const large = f.adjust('40',1_000_000_000,'large');
    assert.equal(large.totalXp,1_000_000_000);
    assert.ok(large.xp>=0 && large.xp<large.level*100);
    assert.equal(large.level*(large.level-1)/2*100+large.xp,large.totalXp);
    const rejected = f.adjust('40',Number.MAX_SAFE_INTEGER,'overflow');assert.match(rejected.rejected,/범위/);
    assert.equal(f.profile('40').totalXp,1_000_000_000);
    assert.equal(f.adjust('40',1,'after-overflow').totalXp,1_000_000_001);
    for (const amount of [0,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) assert.throws(() => f.adjust('40',amount,`invalid-${amount}`), /정수/);
});

test('XP adjustment and season history commit atomically and replay only once', t => {
    const f = fixture(t);
    f.manager.handle.exec("CREATE TRIGGER system.reject_adjustment BEFORE UPDATE ON xp_events WHEN NEW.applied=1 BEGIN SELECT RAISE(ABORT,'retry adjustment'); END");
    assert.throws(() => f.adjust('20',150,'retry-adjustment'), /retry adjustment/);
    assert.equal(f.best('20'),2);assert.equal(f.manager.handle.prepare("SELECT xp FROM users WHERE user_id='20'").get().xp,50);
    f.manager.handle.exec('DROP TRIGGER system.reject_adjustment');f.restart();f.manager.drainEvents();
    assert.equal(f.best('20'),1);assert.equal(f.profile('20').totalXp,200);
    f.adjust('20',150,'retry-adjustment');assert.equal(f.profile('20').totalXp,200);
});

test('XP adjustment at month boundary applies to the new season', t => {
    const f = fixture(t);
    f.setNow('2026-12-01T00:00:00+09:00');
    const result = f.adjust('20',100,'boundary-adjustment');
    assert.equal(result.previousTotalXp,0);assert.equal(result.totalXp,100);
    assert.equal(f.state.get('currentPeriod').month,'2026-12');
    assert.equal(f.best('20'),undefined);assert.equal(f.best('20','2026-11'),2);
    assert.equal(f.profile('20').collecting,true);
    f.setNow('2026-12-02T00:00:00+09:00');assert.equal(f.profile('20').bestRank,1);
});

test('first-day XP accrues without ranking and exactly 24 hours starts a fresh peak', t => {
    const f = fixture(t,undefined,'2026-11-01T00:00:00+09:00');
    assert.equal(f.best('20'),undefined);
    f.adjust('20',200,'warmup-leader');
    assert.equal(f.profile('20').totalXp,250);
    assert.equal(f.profile('20').collecting,true);
    assert.equal(f.profile('20').rank,null);assert.equal(f.profile('20').bestRank,null);
    f.setNow('2026-11-01T23:59:59.999+09:00');
    f.add('30',1000,'warmup-new-leader');
    f.restart();assert.equal(f.profile('20').collecting,true);
    assert.equal(f.state.db.prepare('SELECT count(*) AS n FROM season_rank_history').get().n,0);
    f.setNow('2026-11-02T00:00:00+09:00');
    const profile=f.profile('20');
    assert.equal(profile.collecting,false);assert.equal(profile.rank,2);assert.equal(profile.bestRank,2);
    const recorded=f.state.db.prepare("SELECT recorded_at FROM season_rank_history WHERE season_id='2026-11' AND user_id='20'").get();
    assert.equal(recorded.recorded_at,Date.parse('2026-11-02T00:00:00+09:00'));
    f.adjust('20',2000,'eligible-leader');assert.equal(f.profile('20').bestRank,1);
});

test('replaying first-day XP after 24 hours does not capture intermediate first-day peaks', t => {
    const f = fixture(t,undefined,'2026-11-01T12:00:00+09:00');
    f.add('20',200,'warmup-first');
    f.manager.handle.exec("CREATE TRIGGER system.pending_warmup BEFORE UPDATE ON xp_events WHEN NEW.applied=1 BEGIN SELECT RAISE(ABORT,'pending warmup'); END");
    assert.throws(()=>f.add('30',1000,'warmup-pending'),/pending warmup/);
    f.manager.handle.exec('DROP TRIGGER system.pending_warmup');
    f.setNow('2026-11-02T00:00:00+09:00');f.restart();
    assert.equal(f.best('20'),undefined);
    f.manager.drainEvents();assert.equal(f.best('20'),undefined);
    const profile=f.profile('20');assert.equal(profile.rank,2);assert.equal(profile.bestRank,2);
});

test('a partial season uses its actual start time and missing or invalid metadata stays collecting', t => {
    const f=fixture(t,undefined,'2026-11-15T13:37:00+09:00');
    f.state.set('currentPeriod',{month:'2026-11',start:'2026-11-15T13:37:00+09:00'});
    f.setNow('2026-11-16T00:00:00+09:00');assert.equal(f.profile('20').collecting,true);
    f.setNow('2026-11-16T13:36:59.999+09:00');assert.equal(f.profile('20').rank,null);
    f.setNow('2026-11-16T13:37:00+09:00');assert.equal(f.profile('20').collecting,false);
    f.state.set('currentPeriod',null);assert.equal(f.profile('20').collecting,true);
    f.state.set('currentPeriod',{month:'2026-11',start:'invalid'});assert.equal(f.profile('20').collecting,true);
});

test('archived snapshots taken during the first 24 hours cannot seed best ranks', t => {
    const f=fixture(t,(db,directory)=>{
        db.prepare("UPDATE users SET xp=200 WHERE user_id='20'").run();
        const early=createSnapshot(db,{...period,end:'2026-11-01T12:00:00+09:00',snapshotAt:'2026-11-01T12:00:00+09:00'});
        fs.mkdirSync(path.join(directory,'private'),{recursive:true});
        fs.writeFileSync(path.join(directory,'private','2026-11.json'),JSON.stringify(early));
        db.prepare("UPDATE users SET xp=50 WHERE user_id='20'").run();
    });
    assert.equal(f.profile('20').bestRank,2);
    f.restart();assert.equal(f.profile('20').bestRank,2);
});

test('old databases migrate without treating undated best ranks as eligible records', t => {
    const f=fixture(t,(db,directory)=>{
        fs.mkdirSync(directory,{recursive:true});
        const legacy=new Database(path.join(directory,'system_state.db'));
        legacy.exec(`CREATE TABLE season_rank_history(season_id TEXT,user_id TEXT,best_rank INTEGER,PRIMARY KEY(season_id,user_id));
            INSERT INTO season_rank_history VALUES ('2026-11','20',1)`);
        legacy.close();
    });
    assert.ok(f.state.db.prepare('PRAGMA table_info(season_rank_history)').all().some(c=>c.name==='recorded_at'));
    assert.equal(f.profile('20').rank,2);assert.equal(f.profile('20').bestRank,2);
    f.restart();assert.equal(f.profile('20').bestRank,2);
});

test('voice XP uses persistent XP accounting and respects the first-day rank delay', t => {
    const f=fixture(t,undefined,'2026-11-01T12:00:00+09:00');
    const event={id:'voice:session:first',type:'voice',userId:'20',amount:20,at:Date.parse('2026-11-01T12:01:00+09:00')};
    f.manager.recordXp(event);assert.equal(f.profile('20').totalXp,70);assert.equal(f.profile('20').collecting,true);
    f.restart();f.manager.recordXp(event);assert.equal(f.profile('20').totalXp,70);
    f.setNow('2026-11-02T00:00:00+09:00');
    f.manager.recordXp({...event,id:'voice:session:second',at:Date.parse('2026-11-02T00:00:00+09:00')});
    f.manager.recordXp({...event,id:'voice:session:third',at:Date.parse('2026-11-02T00:01:00+09:00')});
    assert.equal(f.profile('20').totalXp,110);assert.equal(f.profile('20').collecting,false);
    const user=f.manager.handle.prepare("SELECT level,xp FROM users WHERE user_id='20'").get();
    assert.deepEqual(user,{level:2,xp:10});
});
