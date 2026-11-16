'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const vm=require('node:vm');const {EventEmitter}=require('node:events');
const Database=require('better-sqlite3');const discord=require('discord.js');const StateManager=require('../archive/stateManager');const DatabaseManager=require('../archive/databaseManager');
const requireFromMain=require('node:module').createRequire(path.resolve(__dirname,'../main.js'));
test('bot retains commands, channel restriction and XP without retired timers or level notices',async t=>{
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),'onion-main-'));const directory=path.join(temp,'archive');fs.mkdirSync(directory);
    const dbFile=path.join(temp,'levels.db');fs.copyFileSync(path.resolve(__dirname,'../levels.db'),dbFile);
    const state=new StateManager(Database,path.join(directory,'system_state.db'));const manager=new DatabaseManager({Database,dbFile,state,directory});
    const originalStartupBackup=manager.startupBackup.bind(manager);manager.startupBackup=()=>originalStartupBackup(path.join(temp,'levels_backup.db'));
    t.after(()=>{manager.close();state.close();fs.rmSync(temp,{recursive:true,force:true});});
    const sends=[];const registered=[];let client;const intervals=[];const jobs=[];let quizStarted=0;
    const channel={send:async data=>{sends.push(data);}};
    class FakeClient extends EventEmitter{constructor(){super();client=this;this.channels={cache:new discord.Collection([['1467237706378514626',channel]])};this.users={cache:new discord.Collection()};this.guilds={cache:new discord.Collection()};this.user={tag:'test',id:'bot'};}login(){return Promise.resolve();}destroy(){}}
    class FakeRest{setToken(){return this;}async put(route,{body}){registered.push(...body);}}
    class FakeQuiz{start(){quizStarted++;}stop(){}}
    const fakeProcess={env:{DISCORD_TOKEN:'mock',APPLICATION_ID:'123'},once(){},exitCode:0};
    const mocks={dotenv:{config(){}},'discord.js':{...discord,Client:FakeClient,REST:FakeRest},'./archive/archiveManager':{openRuntime:()=>({manager,state,close(){}})},'./archive/githubUploader':class{},'./archive/scheduler':{startScheduler:()=>async()=>{}},'./quiz/quizManager':{QuizManager:FakeQuiz},'node-schedule':{scheduleJob:(rule,callback)=>{jobs.push({rule,callback});return{cancel(){}};}}};
    const customMath=Object.create(Math);customMath.random=()=>0;
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../main.js'),'utf8'),{require:id=>Object.hasOwn(mocks,id)?mocks[id]:requireFromMain(id),__dirname:path.resolve(__dirname,'..'),process:fakeProcess,console:{log(){},error(){}},setInterval:fn=>{intervals.push(fn);return intervals.length;},setTimeout:()=>1,clearInterval(){},clearTimeout(){},Math:customMath,Date});
    await client.listeners('ready')[0]();assert.equal(quizStarted,1);assert.deepEqual(registered.map(c=>c.name),['도움말','프로필','경험치','xp','랭킹','퀴즈설정']);
    assert.equal((registered.find(c=>c.name==='랭킹').options||[]).length,0);
    assert.equal((registered.find(c=>c.name==='경험치').options||[]).length,0);
    assert.deepEqual(registered.find(c=>c.name==='xp').options.map(o=>o.name),['대상','작업','수량']);
    const author={id:'999999999999999999',bot:false,toString:()=>'<@999999999999999999>',username:'테스트',displayAvatarURL:()=> 'https://example.test/avatar.png'};
    manager.handle.prepare('DELETE FROM users WHERE user_id=?').run(author.id);
    const message=client.listeners('messageCreate')[0];
    for(let i=0;i<3;i++)await message({id:String(i),author,guild:{id:'g'},content:'x'.repeat(300)});
    let user=manager.handle.prepare('SELECT * FROM users WHERE user_id=?').get(author.id);assert.equal(user.level,2);assert.equal(user.xp,50);assert.equal(user.weekly_xp,0);assert.equal(sends.length,0);
    assert.equal(intervals.length,0);await message({id:'normal',author,guild:{id:'g'},content:''});user=manager.handle.prepare('SELECT * FROM users WHERE user_id=?').get(author.id);assert.equal(user.xp,60);
    await message({id:'bot',author:{...author,bot:true},guild:{id:'g'},content:'hello'});assert.equal(manager.handle.prepare('SELECT xp FROM users WHERE user_id=?').get(author.id).xp,60);
    assert.equal(jobs.length,0);
    const interaction=client.listeners('interactionCreate')[0];const replies=[];
    for(const commandName of ['경험치','랭킹','도움말'])await interaction({isChatInputCommand:()=>true,channelId:'1467237706378514626',commandName,user:author,reply:async value=>replies.push(value)});
    assert.equal(replies.length,3);assert.ok(replies.every(r=>r.embeds?.length));
    assert.equal(replies[1].embeds[0].data.title,'🏆 전체 랭킹 TOP 10');
    assert.deepEqual(replies[0].embeds[0].data.fields.map(f=>f.name),['레벨','경험치','진행도 (30%)']);
    assert.doesNotMatch(replies[2].embeds[0].data.description,/아이템|상점/);
    const xpInteraction={isChatInputCommand:()=>true,id:'admin-command',channelId:'1467237706378514626',commandName:'xp',user:author,
        options:{getUser:()=>author,getString:()=> 'add',getInteger:()=>100},reply:async value=>replies.push(value),deferReply:async()=>{},editReply:async value=>replies.push(value)};
    await interaction(xpInteraction);assert.match(replies.at(-1).content,/권한/);
    assert.equal(manager.handle.prepare('SELECT xp FROM users WHERE user_id=?').get(author.id).xp,60);
    await interaction({...xpInteraction,user:{...author,id:'1159841882290008216'}});
    assert.equal(replies.at(-1).embeds[0].data.title,'경험치 조정 완료');
    assert.equal(manager.handle.prepare('SELECT xp FROM users WHERE user_id=?').get(author.id).xp,160);
    await interaction({...xpInteraction,id:'admin-command-remove',user:{...author,id:'1159841882290008216'},
        options:{getUser:()=>author,getString:()=> 'remove',getInteger:()=>200}});
    assert.equal(manager.handle.prepare('SELECT level FROM users WHERE user_id=?').get(author.id).level,1);
    assert.equal(manager.handle.prepare('SELECT xp FROM users WHERE user_id=?').get(author.id).xp,60);
    await interaction({isChatInputCommand:()=>true,channelId:'wrong',reply:async v=>replies.push(v)});assert.match(replies.at(-1).content,/전용 채널/);
    await interaction({isChatInputCommand:()=>true,channelId:'1467237706378514626',commandName:'퀴즈설정',user:{...author,id:'1159841882290008216'},options:{getString:()=> '1.2'},reply:async v=>replies.push(v)});
    assert.equal(manager.handle.prepare("SELECT value FROM settings WHERE key='quiz_reward_mode'").get().value,'1.2');
    assert.doesNotMatch(fs.readFileSync(path.resolve(__dirname,'../main.js'),'utf8'),/updateLevelRole|roles\.create|roles\.add|roles\.remove/);
});

test('xp command rejects unauthorized users before reading options and rejects invalid quantities',async()=>{
    const command=require('../commands').find(c=>c.data.name==='xp');
    const replies=[];
    await command.execute({user:{id:'1159841882290008217'},reply:async reply=>replies.push(reply),
        get options(){assert.fail('unauthorized options accessed');}});
    assert.match(replies.at(-1).content,/권한/);assert.equal(replies.at(-1).ephemeral,true);
    for(const quantity of [0,-10,1.5,Number.MAX_SAFE_INTEGER+1]) {
        await command.execute({user:{id:'1159841882290008216'},reply:async reply=>replies.push(reply),
            options:{getUser:()=>({id:'10'}),getString:()=> 'add',getInteger:()=>quantity},
            deferReply(){assert.fail('invalid command deferred');}},null,{manager:{adjustXp(){assert.fail('invalid XP modified');}}});
        assert.match(replies.at(-1).content,/정수/);
    }
});
