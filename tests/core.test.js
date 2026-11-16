'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const StateManager = require('../archive/stateManager');
const DatabaseManager = require('../archive/databaseManager');
const { createSnapshot, validateSnapshot } = require('../archive/snapshot');
const { monthEnd, monthOf, fingerprint, hash, acquireLock } = require('../archive/utils');
const { QuizManager, generateQuestion, rewardAmount, COOLDOWN } = require('../quiz/quizManager');
const GitHubUploader = require('../archive/githubUploader');
const source = path.resolve(__dirname, '../levels.db');
const sourceDb = new Database(source, { readonly: true });
const sourceUserCount = sourceDb.prepare('SELECT count(*) AS n FROM users').get().n;
const sourceTopXp = sourceDb.prepare('SELECT max((level * (level - 1) / 2 * 100) + xp) AS xp FROM users').get().xp;
sourceDb.close();
const files = ['levels.db', 'levels_backup.db', 'bot_database.db', 'commands.js'];
const originalHashes = Object.fromEntries(files.map(file => [file, hash(fs.readFileSync(path.resolve(__dirname, '..', file)))]));
function fixture(t, opts = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onion-test-'));
    const directory = path.join(root, 'archive'); fs.mkdirSync(directory);
    const dbFile = path.join(root, 'levels.db'); fs.copyFileSync(source, dbFile);
    const state = new StateManager(Database, path.join(directory, 'system_state.db'));
    let now = Date.parse('2026-12-01T00:00:00+09:00');
    let manager = new DatabaseManager({ Database, dbFile, state, directory, env: {}, clock: () => now, ...opts });
    const f = { root, directory, dbFile, state, get manager() { return manager; }, setNow(n) { now = Date.parse(n); },
        restart(fault = () => {}) { manager.close(); manager = new DatabaseManager({ Database, dbFile, state, directory, env: {}, clock: () => now, fault }); return manager; } };
    t.after(() => { manager.close(); state.close(); fs.rmSync(root, { recursive: true, force: true }); });
    return f;
}
function period(id = '2026-11') { return { id, start: '2026-11-15T03:00:00+09:00', end: '2026-12-01T00:00:00+09:00', snapshotAt: '2026-12-01T00:00:00+09:00' }; }
function activeQuiz(f, extra = {}) {
    const q = { id: 'test-quiz', state: 'ACTIVE', channelId: '42', messageId: '100', answer: 2,
        createdAt: Date.parse('2026-11-30T23:55:00+09:00'), rewarded: false, ...extra };
    f.state.saveQuiz(q); return q;
}
function fakeMessage(extra = {}) { return { id: '101', content: ' 2 ', channelId: '42', createdTimestamp: Date.parse('2026-12-01T00:03:00+09:00'), author: { id: '9000001', bot: false }, ...extra }; }
test('actual DB schema, current user count, original XP formula, deterministic ordering', t => {
    const f = fixture(t); const db = f.manager.handle;
    const s = createSnapshot(db, period());
    assert.equal(s.totalUsers, sourceUserCount);
    assert.equal(s.rankings[0].totalXp, sourceTopXp);
    for (const r of s.rankings) {
        const value = db.prepare('SELECT ((level*(level-1)/2*100)+xp) total FROM users WHERE user_id=?').get(r.userId).total;
        assert.equal(r.totalXp, value);
    }
    db.prepare('DELETE FROM users').run(); assert.equal(createSnapshot(db, period()).totalUsers, 0);
    for (const id of ['30','10','20']) db.prepare('INSERT INTO users(user_id,xp,level) VALUES (?,5,1)').run(id);
    assert.deepEqual(createSnapshot(db, period()).rankings.map(r => r.userId), ['10','20','30']);
    db.prepare("DELETE FROM users WHERE user_id<>'10'").run(); assert.equal(createSnapshot(db, period()).totalUsers, 1);
    db.prepare("UPDATE users SET xp=NULL WHERE user_id='10'").run(); assert.throws(() => createSnapshot(db, period()), /Invalid ranking/);
});
test('large ranking data stays deterministic', t => {
    const f = fixture(t); const db = f.manager.handle; db.exec('DELETE FROM users');
    db.transaction(() => { const put = db.prepare('INSERT INTO users(user_id,xp,level) VALUES (?,0,1)'); for (let i=1; i<=10000; i++) put.run(String(i)); })();
    const s = createSnapshot(db, period()); assert.equal(s.totalUsers, 10000); validateSnapshot(s);
});
test('public scope and opt-out are applied before serializing; private users stay in DB', t => {
    const f = fixture(t); const rows = f.manager.handle.prepare('SELECT user_id FROM users LIMIT 3').all();
    const ids = rows.map(r => r.user_id);
    const env = { ARCHIVE_PUBLIC_USER_IDS: ids.join(', '), ARCHIVE_EXCLUDED_USER_IDS: ' '+ids[1]+' ' };
    const s = createSnapshot(f.manager.handle, period(), { publicOnly: true, env });
    assert.equal(s.totalUsers, 2); assert.ok(!s.rankings.some(r => r.userId === ids[1]));
    assert.equal(createSnapshot(f.manager.handle, period(), { publicOnly: true, env: {} }).totalUsers, 0);
    assert.equal(f.manager.handle.prepare('SELECT count(*) n FROM users').get().n, sourceUserCount);
});
test('rollover retains all tables/settings, zeros only requested user fields and redirects cached statement', t => {
    const f = fixture(t); const db = f.manager.handle;
    db.exec('CREATE TABLE extra(data TEXT); INSERT INTO extra VALUES (\'preserved\')');
    db.prepare("UPDATE settings SET value='1.2' WHERE key='quiz_reward_mode'").run();
    const before = fingerprint(db);
    const cached = f.manager.db.prepare('SELECT SUM(xp) xp FROM users');
    const q = activeQuiz(f);
    const job = f.manager.rollover(period());
    assert.equal(job.switched, true); assert.equal(job.uploaded, false);
    assert.equal(cached.get().xp, 0);
    assert.equal(f.manager.handle.prepare('SELECT count(*) n FROM users WHERE level<>1 OR xp<>0 OR weekly_xp<>0 OR item1+item2+item3+item4+item5<>0').get().n, 0);
    assert.equal(f.manager.handle.prepare('SELECT * FROM extra').get().data, 'preserved');
    assert.equal(f.manager.handle.prepare("SELECT value FROM settings WHERE key='quiz_reward_mode'").get().value, '1.2');
    const old = new Database(job.backup, { readonly: true }); assert.equal(fingerprint(old), before); old.close();
    assert.deepEqual(f.state.quiz(), q);
    assert.deepEqual(f.manager.rollover(period()), job);
});
test('year/month boundaries use Seoul independently of host TZ', () => {
    assert.equal(monthOf('2026-12-31T15:00:00Z'), '2027-01');
    assert.equal(monthEnd('2026-12'), '2026-12-31T15:00:00.000Z');
    assert.equal(monthEnd('2028-02'), '2028-02-29T15:00:00.000Z');
});
for (const stage of ['BACKED_UP','SNAPSHOTTED','CANDIDATE_CREATED','CANDIDATE_RESET','SWITCHING','OLD_RENAMED','NEW_RENAMED']) test(`interrupted rollover recovers at ${stage} without losing XP or rewriting backup`, t => {
    let fired = false;
    const f = fixture(t, { fault: s => { if (s === stage && !fired) { fired = true; throw new Error('injected crash'); } } });
    assert.throws(() => f.manager.rollover(period()), /injected crash/);
    const backup = path.join(f.directory, 'backups', 'levels_2026-11.old.db'); const saved = hash(fs.readFileSync(backup));
    f.restart(); f.manager.rollover(period());
    assert.equal(f.state.settlement('2026-11').switched, true);
    assert.equal(hash(fs.readFileSync(backup)), saved);
    assert.equal(f.manager.handle.prepare('SELECT SUM(xp) xp FROM users').get().xp, 0);
});
test('unowned old DB never overwritten and source remains usable', t => {
    const f = fixture(t); const before = fingerprint(f.manager.handle);
    fs.mkdirSync(path.join(f.directory, 'backups')); const backup = path.join(f.directory, 'backups','levels_2026-11.old.db');
    fs.writeFileSync(backup, 'do not overwrite');
    assert.throws(() => f.manager.rollover(period()), /Unowned backup/);
    assert.equal(fs.readFileSync(backup, 'utf8'), 'do not overwrite'); assert.equal(fingerprint(f.manager.handle), before);
});
for(const stage of ['BACKED_UP','CANDIDATE_CREATED','SWITCHING','OLD_RENAMED','NEW_RENAMED'])test(`process exit without close recovers at ${stage}`,t=>{
    const {spawnSync}=require('node:child_process');const f=fixture(t);f.manager.close();
    const child=spawnSync(process.execPath,[path.join(__dirname,'crash-worker.cjs'),f.dbFile,f.directory,stage],{encoding:'utf8'});
    assert.equal(child.status,77,child.stderr);
    f.restart();f.manager.rollover(period());assert.equal(f.state.settlement('2026-11').switched,true);
    assert.equal(f.manager.handle.pragma('integrity_check',{simple:true}),'ok');
});
test('initial reset blocked until verified upload is recorded, and initial never runs automatically', t => {
    const f = fixture(t); f.manager.ensurePeriod(); assert.equal(f.state.settlements().length, 0);
    const p = { ...period('2026-initial'), start: '2026-02-18T00:00:00+09:00' };
    const before = fingerprint(f.manager.handle);
    assert.throws(() => f.manager.rollover(p, { initial: true }), /requires verified upload/);
    assert.equal(fingerprint(f.manager.handle), before);
    f.state.saveSettlement({ ...f.state.settlement(p.id), uploaded: true });
    assert.equal(f.manager.rollover(p, { initial: true }).switched, true);
});
test('safe backup includes WAL commits and preserves startup backup function', t => {
    const f = fixture(t); f.manager.handle.exec("DETACH DATABASE system"); f.manager.handle.pragma('journal_mode = WAL');
    f.manager.handle.exec("INSERT INTO users(user_id,xp,level) VALUES ('999999',73,1)");
    const dest = path.join(f.root, 'safe.db'); f.manager.safeBackup(dest);
    const d = new Database(dest,{readonly:true}); assert.equal(d.prepare("SELECT xp FROM users WHERE user_id='999999'").get().xp,73); d.close();
    const startup = path.join(f.root, 'levels_backup.db'); f.manager.startupBackup(startup); f.manager.startupBackup(startup);
    const b = new Database(startup, {readonly:true}); assert.equal(b.pragma('integrity_check', {simple:true}),'ok'); b.close();
});
test('quiz reward formula, question ranges and operators unchanged', () => {
    assert.equal(rewardAmount({level:3,xp:50},'RANDOM',()=>0),100);
    assert.equal(rewardAmount({level:3,xp:50},'RANDOM',()=>.99999),500);
    for (const mode of ['1.1','1.2']) assert.equal(rewardAmount({level:3,xp:50},mode),Math.floor(350*(parseFloat(mode)-1)));
    for (let i=0;i<100;i++){const q=generateQuestion(); assert.ok(q.n1>=1&&q.n1<=50&&q.n2>=1&&q.n2<=50);assert.ok(['+','-','*'].includes(q.op));}
});
test('quiz claim commits XP and cooldown atomically, first winner only and survives restart', t => {
    const f = fixture(t); activeQuiz(f);
    const now = Date.parse('2026-12-01T00:03:00+09:00');
    const quiz = new QuizManager({manager:f.manager,state:f.state,channelId:'42',clock:()=>now});
    const m=fakeMessage(); const result=quiz.claim(m); assert.ok(result); assert.equal(result.quiz.nextQuizAt,now+COOLDOWN);
    assert.equal(quiz.claim(m),null);
    const user = f.manager.handle.prepare('SELECT * FROM users WHERE user_id=?').get(m.author.id);
    assert.equal((user.level*(user.level-1)/2*100)+user.xp,result.rewardXp);
    f.restart(); const restarted=new QuizManager({manager:f.manager,state:f.state,clock:()=>now}); assert.equal(restarted.claim(m),null);
});
test('reward transaction rollback preserves winner intent and replay pays once', t => {
    const f=fixture(t); const q=activeQuiz(f); const before=fingerprint(f.manager.handle);
    f.manager.handle.exec("CREATE TRIGGER system.block_quiz BEFORE UPDATE ON quiz WHEN json_extract(NEW.value,'$.rewarded')=1 BEGIN SELECT RAISE(ABORT,'injected'); END;");
    const quiz=new QuizManager({manager:f.manager,state:f.state,clock:()=>Date.parse('2026-12-01T00:03:00+09:00')});
    assert.throws(()=>quiz.claim(fakeMessage()),/injected/);assert.equal(fingerprint(f.manager.handle),before);
    assert.equal(f.state.quiz().state,'REWARDED');assert.equal(f.state.quiz().rewarded,false);
    f.manager.handle.exec('DROP TRIGGER system.block_quiz');f.restart();f.manager.drainEvents();
    assert.equal(f.state.quiz().rewarded,true);assert.equal(f.state.quiz().state,'COOLDOWN');
    const after=fingerprint(f.manager.handle);f.manager.drainEvents();assert.equal(fingerprint(f.manager.handle),after);
});
test('quiz ignores bots, other channels, earlier messages and offline backlog', t => {
    const f=fixture(t);const q=activeQuiz(f);const quiz=new QuizManager({manager:f.manager,state:f.state,clock:()=>Date.parse('2026-12-01T00:02:00+09:00')});
    assert.equal(quiz.accepts(fakeMessage(),q),true);
    for(const change of [{author:{id:'1',bot:true}},{channelId:'wrong'},{id:'99'},{createdTimestamp:q.createdAt},{content:'3'}]) assert.equal(quiz.accepts(fakeMessage(change),q),false);
});
test('quiz before month end awards old period; quiz after midnight awards new period', t => {
    const f=fixture(t); f.state.set('currentPeriod',{month:'2026-11',start:period().start});
    let now=Date.parse('2026-11-30T23:59:58+09:00'); f.setNow('2026-11-30T23:59:58+09:00');activeQuiz(f);
    const quiz=new QuizManager({manager:f.manager,state:f.state,clock:()=>now});
    const first=fakeMessage({createdTimestamp:now});const reward=quiz.claim(first); assert.ok(reward);
    f.setNow('2026-12-01T00:00:00+09:00');f.manager.ensurePeriod();
    const job=f.state.settlement('2026-11');const old=new Database(job.backup,{readonly:true});assert.ok(old.prepare('SELECT xp,level FROM users WHERE user_id=?').get(first.author.id));old.close();
    assert.equal(f.manager.handle.prepare('SELECT xp FROM users WHERE user_id=?').get(first.author.id).xp,0);
    assert.equal(f.state.quiz().nextQuizAt,Date.parse('2026-12-01T00:04:58+09:00'));
    now=Date.parse('2026-12-01T00:03:00+09:00');activeQuiz(f,{id:'second'});assert.ok(quiz.claim(fakeMessage()));
    assert.ok(f.manager.handle.prepare('SELECT level,xp FROM users WHERE user_id=?').get(first.author.id));
});
test('answer arriving at rollover triggers switch first and is paid exactly once in new DB', t => {
    const f=fixture(t);f.state.set('currentPeriod',{month:'2026-11',start:period().start});activeQuiz(f);
    const quiz=new QuizManager({manager:f.manager,state:f.state,clock:()=>Date.parse('2026-12-01T00:00:00+09:00')});
    const result=quiz.claim(fakeMessage());assert.ok(result);assert.equal(f.state.settlement('2026-11').switched,true);
    const old=new Database(f.state.settlement('2026-11').backup,{readonly:true});assert.equal(old.prepare("SELECT * FROM users WHERE user_id='9000001'").get(),undefined);old.close();
    assert.equal(quiz.claim(fakeMessage()),null);
});
test('delayed restart settles one honest extended period instead of inventing historical months', t => {
    const f=fixture(t);f.state.set('currentPeriod',{month:'2026-11',start:period().start});f.setNow('2027-02-04T12:00:00+09:00');f.manager.ensurePeriod();
    const job=f.state.settlement('2026-11');assert.equal(job.period.accuracy,'delayed-extraction');assert.equal(f.state.settlements().length,1);
    assert.equal(f.state.get('currentPeriod').month,'2027-02');
});
test('runtime lock prevents concurrent bot/CLI', t => {
    const f=fixture(t);const release=acquireLock(f.directory);assert.throws(()=>acquireLock(f.directory),/already running/);release();
});
test('durable message XP replays once after failed DB rollover', t => {
    let fail=true;
    const f=fixture(t,{fault:stage=>{if(fail&&stage==='SWITCHING')throw new Error('disk failure');}});
    f.state.set('currentPeriod',{month:'2026-11',start:period().start});
    const event={id:'message:500',type:'message',userId:'99999999',amount:50,at:Date.parse('2026-12-01T00:00:00+09:00')};
    assert.throws(()=>f.manager.recordXp(event),/disk failure/);
    assert.equal(f.state.db.prepare('SELECT applied FROM xp_events WHERE id=?').get(event.id).applied,0);
    fail=false;f.restart();f.manager.drainEvents();
    assert.equal(f.manager.handle.prepare('SELECT xp FROM users WHERE user_id=?').get(event.userId).xp,50);
    f.manager.recordXp(event);assert.equal(f.manager.handle.prepare('SELECT xp FROM users WHERE user_id=?').get(event.userId).xp,50);
});
test('retry keeps the original snapshot timestamp while later events enter the new month',t=>{
    let fail=true;const f=fixture(t,{fault:stage=>{if(fail&&stage==='SNAPSHOTTED')throw new Error('offline disk');}});
    f.state.set('currentPeriod',{month:'2026-11',start:period().start});assert.throws(()=>f.manager.ensurePeriod(),/offline disk/);
    const saved=f.state.settlement('2026-11').period.snapshotAt;
    fail=false;f.restart();f.setNow('2026-12-01T00:02:00+09:00');
    assert.doesNotThrow(()=>f.manager.recordXp({id:'message:retry',type:'message',userId:'7777777',amount:20,at:Date.parse('2026-12-01T00:02:00+09:00')}));
    assert.equal(f.state.settlement('2026-11').period.snapshotAt,saved);assert.equal(f.state.get('currentPeriod').month,'2026-12');
    assert.equal(f.manager.handle.prepare("SELECT xp FROM users WHERE user_id='7777777'").get().xp,20);
});
test('restores active collector without timeout or duplicate send; 30 minutes unanswered leaves it active', async t => {
    const {EventEmitter}=require('node:events');const f=fixture(t);activeQuiz(f);
    let now=Date.parse('2026-12-01T00:03:00+09:00');let sends=0;let options;const timers=[];
    const collector=new EventEmitter();collector.stop=()=>{};
    const channel={isTextBased:()=>true,messages:{fetch:async()=>({id:'100'})},createMessageCollector:o=>{options=o;return collector;},send:async()=>{sends++;}};
    const client={channels:{fetch:async()=>channel}};
    const quiz=new QuizManager({client,manager:f.manager,state:f.state,channelId:'42',clock:()=>now,timers:{setTimeout:(fn,delay)=>{timers.push({fn,delay});return timers.length;},clearTimeout:()=>{}}});
    await quiz.start();await quiz.start();assert.equal(sends,0);assert.equal(options.time,undefined);assert.equal(options.max,undefined);
    now+=30*60000;assert.equal(f.state.quiz().state,'ACTIVE');assert.equal(timers.length,0);
    quiz.stop();
});
test('cooldown restart waits only remaining duration and overdue cooldown runs immediately', async t => {
    const f=fixture(t);const now=Date.parse('2026-12-01T00:03:00+09:00');activeQuiz(f,{state:'COOLDOWN',rewarded:true,nextQuizAt:now+120000});
    const calls=[];const timers={setTimeout:(fn,delay)=>{calls.push({fn,delay});return calls.length;},clearTimeout:()=>{}};
    const client={channels:{fetch:async()=>({isTextBased:()=>true})}};
    const quiz=new QuizManager({client,manager:f.manager,state:f.state,channelId:'42',clock:()=>now,timers});await quiz.start();assert.equal(calls[0].delay,120000);quiz.stop();
    const late=new QuizManager({client,manager:f.manager,state:f.state,channelId:'42',clock:()=>now+180000,timers});await late.start();assert.equal(calls.at(-1).delay,0);late.stop();
});
test('uncertain old send fails closed instead of duplicating question', async t => {
    const f=fixture(t);activeQuiz(f,{messageId:null,nonce:'unknown'});let sends=0;
    const client={user:{id:'bot'},channels:{fetch:async()=>({isTextBased:()=>true,messages:{fetch:async()=>({size:0,find:()=>undefined})},send:async()=>{sends++;}})}};
    const quiz=new QuizManager({client,manager:f.manager,state:f.state,channelId:'42',clock:()=>Date.parse('2026-12-01T00:03:00+09:00'),timers:{setTimeout:()=>1,clearTimeout:()=>{}}});
    await quiz.start();assert.equal(sends,0);assert.equal(f.state.quiz().state,'ACTIVE');quiz.stop();
});
function fakeGitHub() {
    const files = new Map(); let puts=0; let fail=0;
    return { files, get puts(){return puts;}, fail(n){fail=n;}, async fetch(url, options={}) {
        if(fail-->0) throw new Error('network');
        const key=decodeURIComponent(new URL(url).pathname.split('/contents/')[1]);const old=files.get(key);
        if(options.method==='PUT') {
            const body=JSON.parse(options.body);
            if((old && body.sha!==old.sha)||(!old&&body.sha)) return new Response('{}',{status:409});
            files.set(key,{sha:String(++puts),value:JSON.parse(Buffer.from(body.content,'base64'))});return new Response('{}',{status:200});
        }
        return old ? new Response(JSON.stringify({sha:old.sha,encoding:'base64',content:Buffer.from(JSON.stringify(old.value)).toString('base64')}),{status:200}) : new Response('{}',{status:404});
    } };
}
const uploadEnv={ARCHIVE_PUBLIC_UPLOAD:'true',GITHUB_TOKEN:'test-only',GITHUB_OWNER:'owner',GITHUB_REPO:'repo',ARCHIVE_PUBLIC_USER_IDS:'1'};
test('GitHub upload verifies files, merges index, is idempotent, refuses immutable conflicts and retries network', async t => {
    const f=fixture(t);const snapshot=createSnapshot(f.manager.handle,period(),{publicOnly:true,env:{}});
    const github=fakeGitHub();const uploader=new GitHubUploader({env:uploadEnv,fetchImpl:github.fetch,sleep:async()=>{}});
    github.fail(2);await uploader.upload(snapshot);assert.equal(github.puts,2);await uploader.upload(snapshot);assert.equal(github.puts,2);
    await assert.rejects(uploader.upload({...snapshot,title:'different'}),/Immutable archive differs/);
    await uploader.upload({...snapshot,id:'2026-12',month:'2026-12'});assert.equal(github.files.get('website/public/data/index.json').value.archives.length,2);
});
test('GitHub auth, rate-limit errors and publication gate stay separate', async () => {
    assert.throws(()=>new GitHubUploader({env:{}}).preflight(),/disabled/);
    for(const [status,headers,category] of [[401,{},'AUTHORIZATION'],[403,{'x-ratelimit-remaining':'0'},'RATE_LIMIT'],[500,{},'HTTP']]) {
        const uploader=new GitHubUploader({env:uploadEnv,fetchImpl:async()=>new Response('{}',{status,headers}),sleep:async()=>{}});
        await assert.rejects(uploader.request('index.json'),new RegExp(category));
    }
});
test('explicit privacy removal updates remote archive/index but cannot modify surviving XP', async t => {
    const f=fixture(t);const full=createSnapshot(f.manager.handle,period());const github=fakeGitHub();
    const uploader=new GitHubUploader({env:uploadEnv,fetchImpl:github.fetch,sleep:async()=>{}});
    await uploader.upload(full);const rankings=full.rankings.slice(1).map((r,i)=>({...r,rank:i+1}));
    const redacted={...full,rankings,totalUsers:rankings.length};await uploader.upload(redacted,{privacyReplacement:true});
    assert.equal(github.files.get('website/public/data/index.json').value.archives[0].totalUsers,full.totalUsers-1);
    const altered={...redacted,rankings:redacted.rankings.map((r,i)=>i? r:{...r,username:'changed'})};
    await assert.rejects(uploader.upload(altered,{privacyReplacement:true}),/only remove users/);
});
test('failed upload preserves snapshot/backup and does not prevent following period', async t => {
    const f=fixture(t);const first=f.manager.rollover(period());
    const uploader=new GitHubUploader({env:uploadEnv,fetchImpl:async()=>{throw new Error('offline');},sleep:async()=>{}});
    await uploader.retry(f.state);assert.equal(f.state.settlement(first.id).uploaded,false);assert.ok(fs.existsSync(first.backup)&&fs.existsSync(first.snapshot));
    f.setNow('2027-01-01T00:00:00+09:00');f.manager.ensurePeriod();assert.equal(f.state.settlements().length,2);
});
test('source DBs and commands remain byte-for-byte unchanged after all tests', () => {
    for(const file of files) assert.equal(hash(fs.readFileSync(path.resolve(__dirname,'..',file))),originalHashes[file],file);
});
test('real initial dry-run changes no project archive files and opens no runtime state',()=>{
    const {spawnSync}=require('node:child_process');
    const archive=path.resolve(__dirname,'../archive');const before=fs.readdirSync(archive).sort();
    const child=spawnSync(process.execPath,[path.resolve(__dirname,'../archive/cli.js'),'initial','--dry-run'],{encoding:'utf8',cwd:path.resolve(__dirname,'..')});
    assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).totalUsers,sourceUserCount);
    assert.deepEqual(fs.readdirSync(archive).sort(),before);
    for(const file of files)assert.equal(hash(fs.readFileSync(path.resolve(__dirname,'..',file))),originalHashes[file]);
});
test('restore CLI creates verified new file and never overwrites an existing destination',t=>{
    const {spawnSync}=require('node:child_process');const f=fixture(t);const job=f.manager.rollover(period());
    const target=path.join(f.root,'recovery.db');const args=[path.resolve(__dirname,'../archive/cli.js'),'restore','--from',job.backup,'--to',target,'--bot-stopped'];
    const first=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(first.status,0,first.stderr);
    const restored=new Database(target,{readonly:true});assert.equal(fingerprint(restored),job.sourceHash);restored.close();
    const saved=hash(fs.readFileSync(target));const second=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(second.status,1);assert.equal(hash(fs.readFileSync(target)),saved);
});
test('monthly scheduler targets midnight Seoul and cancels cleanly',async t=>{
    const f=fixture(t);const schedule=require('node-schedule');const {startScheduler}=require('../archive/scheduler');
    const existing=new Set(Object.keys(schedule.scheduledJobs));const stop=startScheduler(f.manager,{retry:async()=>{}},f.state);
    const job=Object.entries(schedule.scheduledJobs).find(([id])=>!existing.has(id))[1];
    try{assert.equal(job.nextInvocation().toISOString(),monthEnd(monthOf(Date.now())));}
    finally{await stop();}
});
