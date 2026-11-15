'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createRequire}=require('node:module');
const webRequire=createRequire(path.resolve(__dirname,'../website/package.json'));
const {JSDOM}=webRequire('jsdom');
const ts=webRequire('typescript');
const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'https://example.test/onion/'});
global.window=dom.window;global.document=dom.window.document;
Object.defineProperty(global,'navigator',{value:dom.window.navigator,configurable:true});
global.location=dom.window.location;global.IS_REACT_ACT_ENVIRONMENT=true;
for(const extension of ['.tsx','.ts']) require.extensions[extension]=(mod,file)=>{
    const source=fs.readFileSync(file,'utf8').replaceAll('import.meta.env.BASE_URL',"'./'");
    mod._compile(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);
};
require.extensions['.css']=()=>{};
const React=webRequire('react');const {createRoot}=webRequire('react-dom/client');const App=require('../website/src/App.tsx').default;
const root=createRoot(document.getElementById('root'));
const rankings=Array.from({length:60},(_,i)=>({rank:i+1,userId:String(900000000000000000n+BigInt(i)),username:i===0?'':`테스트${i+1}`,level:60-i,xp:0,totalXp:(60-i)*(59-i)/2*100,avatarUrl:'https://cdn.discordapp.com/avatars/mock/test.png'}));
const snapshot={schemaVersion:1,id:'2026-11',type:'monthly',month:'2026-11',title:'2026년 11월 랭킹',periodStart:'2026-11-15T00:00:00+09:00',periodEnd:'2026-12-01T00:00:00+09:00',snapshotAt:'2026-12-01T00:00:00+09:00',accuracy:'live-boundary',partialPeriod:true,totalUsers:60,rankings};
const entry={...snapshot,path:'archives/2026-11.json'};delete entry.rankings;
let fail=false;let empty=false;let invalid=false;
global.fetch=async url=>{
    if(fail)return new Response('{}',{status:503});
    return new Response(JSON.stringify(String(url).endsWith('index.json')?{schemaVersion:1,archives:empty?[]:[entry]}:invalid?{...snapshot,rankings:null}:snapshot),{status:200});
};
const text=()=>document.body.textContent;
const button=label=>[...document.querySelectorAll('button')].find(b=>b.textContent===label||b.getAttribute('aria-label')===label);
const click=async b=>React.act(async()=>{b.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));});
const settle=async()=>React.act(async()=>{await new Promise(r=>setTimeout(r,10));});
test('website loads JSON at repository base, shows fallback names and paginates 60 rows',async()=>{
    await React.act(async()=>root.render(React.createElement(App)));await settle();
    assert.match(text(),/2026년 11월 랭킹/);assert.equal(document.querySelectorAll('tbody tr').length,25);assert.match(text(),/사용자 900000000000000000/);
    await click(button('다음 페이지'));assert.equal(document.querySelector('tbody tr .rank').textContent,'26');
    await click(button('다음 페이지'));assert.equal(document.querySelectorAll('tbody tr').length,10);assert.equal(button('다음 페이지').disabled,true);
});
test('website search by name and ID, no results, rank sort and avatar fallback',async()=>{
    const input=document.querySelector('input');const setter=Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set;
    async function type(value){await React.act(async()=>{setter.call(input,value);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});}
    await type('테스트42');assert.equal(document.querySelectorAll('tbody tr').length,1);assert.match(text(),/테스트42/);
    await type('900000000000000059');assert.equal(document.querySelectorAll('tbody tr').length,1);assert.match(text(),/테스트60/);
    await type('없는사용자');assert.match(text(),/검색 결과가 없습니다/);
    await type('');await click(button('순위 정렬 변경'));assert.equal(document.querySelector('tbody tr .rank').textContent,'60');
    const img=document.querySelector('.avatar img');await React.act(async()=>img.dispatchEvent(new dom.window.Event('error')));assert.ok(document.querySelector('.avatar').textContent);
});
test('website JSON failure offers retry, handles empty archives and unknown hash',async()=>{
    fail=true;await React.act(async()=>{location.hash='missing';window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));});await settle();
    assert.match(text(),/해당 기록을 찾을 수 없습니다/);await click(button('다시 불러오기'));await settle();assert.match(text(),/기록을 불러오지 못했습니다/);
    fail=false;empty=true;await React.act(async()=>{location.hash='';window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));});await click(button('다시 불러오기'));await settle();assert.match(text(),/아직 보관된 기록이 없어요/);
});
test('website rejects invalid archive JSON and hash reload returns to chosen archive',async()=>{
    empty=false;invalid=true;
    await React.act(async()=>{root.unmount();});
    // A fresh mount models a GitHub Pages reload: only the URL hash contains routing state.
    location.hash='2026-11';const next=createRoot(document.getElementById('root'));
    await React.act(async()=>next.render(React.createElement(App)));await settle();assert.match(text(),/기록 데이터가 올바르지 않습니다/);
    invalid=false;await click(button('다시 불러오기'));await settle();assert.match(text(),/2026년 11월 랭킹/);assert.equal(document.querySelectorAll('tbody tr').length,25);
    await React.act(async()=>next.unmount());
});
after(()=>dom.window.close());
