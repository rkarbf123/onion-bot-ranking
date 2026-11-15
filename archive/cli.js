#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { openRuntime } = require('./archiveManager');
const StateManager = require('./stateManager');
const { createSnapshot } = require('./snapshot');
const { integrity, fingerprint, monthEnd, acquireLock } = require('./utils');
const GitHubUploader = require('./githubUploader');
const { fetchProfiles } = require('./profiles');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'archive');
const args = process.argv.slice(2);
const command = args[0];
const flag = name => args.includes(name);
const option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const readState = () => fs.existsSync(path.join(directory, 'system_state.db')) ? new StateManager(Database, path.join(directory, 'system_state.db'), { readonly: true }) : null;
function initialPeriod() {
    const now = new Date().toISOString();
    return { id: '2026-initial', start: '2026-02-18T00:00:00+09:00', end: now, snapshotAt: now, accuracy: 'actual-extraction' };
}
function preview() {
    const state = readState();
    const db = new Database(path.join(root, 'levels.db'), { readonly: true, fileMustExist: true });
    try {
        integrity(db);
        const current = state?.get('currentPeriod');
        if (command === 'monthly' && !current) throw new Error('Complete the initial settlement first');
        const period = command === 'initial' ? initialPeriod() : { id: current.month, start: current.start,
            end: new Date().toISOString(), snapshotAt: new Date().toISOString(), scheduledEnd: monthEnd(current.month) };
        const snapshot = createSnapshot(db, period);
        const publicSnapshot = createSnapshot(db, period, { publicOnly: true });
        console.log(JSON.stringify({ dryRun: true, target: period, fingerprint: fingerprint(db), totalUsers: snapshot.totalUsers,
            publicUsers: publicSnapshot.totalUsers, top: snapshot.rankings.slice(0, 10),
            historicalWarning: 'XP 변경 이력이 없어 11월 15일의 정확한 과거 상태로 검증할 수 없습니다. 실제 추출 시각으로 기록합니다.',
            next: `--commit --confirm ${period.id} --bot-stopped --accept-extraction-time` }, null, 2));
    } finally { db.close(); state?.close(); }
}
async function main() {
    if (['initial', 'monthly'].includes(command) && flag('--dry-run')) return preview();
    if (command === 'status') {
        const state = readState();
        try { console.log(JSON.stringify({ currentPeriod: state?.get('currentPeriod') || null, switch: state?.get('switch') || null,
            settlements: state?.settlements() || [], quiz: state?.quiz() ? { state: state.quiz().state, id: state.quiz().id, nextQuizAt: state.quiz().nextQuizAt } : null }, null, 2)); }
        finally { state?.close(); } return;
    }
    if (command === 'verify') {
        const state = readState();
        try {
            for (const job of state?.settlements() || []) {
                const db = new Database(job.backup, { readonly: true, fileMustExist: true });
                try { integrity(db); if (fingerprint(db) !== job.sourceHash) throw new Error(`${job.id}: backup fingerprint differs`); }
                finally { db.close(); }
                console.log(`${job.id}: old DB verified`);
            }
            console.log('검증 완료');
        } finally { state?.close(); } return;
    }
    if (command === 'restore') {
        const from=option('--from');const to=option('--to');
        if (!from || !to || !flag('--bot-stopped')) throw new Error('restore --from OLD_DB --to NEW_PATH --bot-stopped');
        const destination=path.resolve(to);
        if(fs.existsSync(destination)) throw new Error('Restore destination already exists; refusing overwrite');
        const db=new Database(path.resolve(from),{readonly:true,fileMustExist:true});
        try {
            integrity(db);fs.mkdirSync(path.dirname(destination),{recursive:true});
            await db.backup(destination);
            const restored=new Database(destination,{readonly:true});
            try { integrity(restored);if(fingerprint(restored)!==fingerprint(db)) throw new Error('Restore fingerprint differs'); }
            finally {restored.close();}
            console.log('검증된 복원 복사본:',destination,'운영 DB는 변경하지 않았습니다.');
        } finally {db.close();}return;
    }
    if (['initial', 'monthly'].includes(command)) {
        if (!flag('--commit') || !flag('--bot-stopped') || !flag('--accept-extraction-time')) throw new Error('Run --dry-run first. Commit requires --commit --confirm ID --bot-stopped --accept-extraction-time');
        if (command === 'initial' && option('--confirm') !== '2026-initial') throw new Error('Expected --confirm 2026-initial');
        const uploader = new GitHubUploader();
        if (command === 'initial') uploader.preflight();
        let profiles={};
        const runtime = openRuntime({names:()=>profiles});
        try {
            const { manager, state } = runtime;
            if (command === 'initial') {
                if (state.get('initialCompleted')) throw new Error('Initial settlement is already complete');
                const old = state.settlement('2026-initial');
                profiles = old?.names || old?.profiles || await fetchProfiles();
                const period = old?.period || initialPeriod();
                console.log('대상 기간:', JSON.stringify(period));
                const job = manager.rollover(period, { beforeSwitch: true });
                await uploader.upload(JSON.parse(fs.readFileSync(job.snapshot, 'utf8')));
                state.saveSettlement({ ...job, profiles, uploaded: true, uploadStatus: 'UPLOADED', status: 'UPLOADED' });
                manager.rollover(period, { initial: true });
            } else {
                const current = state.get('currentPeriod');
                if (!current || option('--confirm') !== current.month) throw new Error('Expected --confirm with the active month');
                if (Date.now() < Date.parse(monthEnd(current.month))) throw new Error('Cannot settle an unfinished month');
                console.log('대상 기간:', JSON.stringify(current)); manager.ensurePeriod();
            }
            console.log('DB 전환 완료. 봇을 다시 시작하세요.');
        } finally { runtime.close(); }
        return;
    }
    if (['retry-upload', 'redact', 'quiz-attach', 'quiz-reset'].includes(command)) {
        if (!flag('--bot-stopped')) throw new Error('Stop the bot and pass --bot-stopped');
        const release = acquireLock(directory); let state;
        try {
            state = new StateManager(Database, path.join(directory, 'system_state.db'));
            if (command === 'retry-upload' || command === 'redact') {
                if(command==='redact') {
                    const id=option('--archive');const userId=option('--user-id');const job=state.settlement(id);
                    if(!job?.snapshot || !/^\d+$/.test(userId||'') || option('--confirm')!==id || !flag('--commit')) throw new Error('redact --archive ID --user-id ID --commit --confirm ID --bot-stopped');
                    state.saveSettlement({...job,uploaded:false,privacyReplacement:true,privacyRemovals:[...new Set([...(job.privacyRemovals||[]),userId])]});
                }
                const uploader = new GitHubUploader(); uploader.preflight(); await uploader.retry(state);
                const failed = state.settlements().filter(s => !s.uploaded);
                if (failed.length) throw new Error(JSON.stringify(failed.map(j => ({ id: j.id, error: j.uploadError }))));
            } else {
                const quiz = state.quiz();
                if (!quiz || option('--confirm') !== quiz.id) throw new Error('Expected --confirm with current quiz ID');
                if (command === 'quiz-attach') {
                    const messageId = option('--message-id');
                    if (!/^\d+$/.test(messageId || '') || quiz.rewarded) throw new Error('Valid message ID and unrewarded quiz required');
                    state.saveQuiz({ ...quiz, messageId });
                } else {
                    if (quiz.rewarded || quiz.winnerId || (quiz.messageId ? !flag('--verified-message-deleted') : !flag('--verified-no-message'))) throw new Error('Reset requires an unrewarded/unclaimed quiz and --verified-no-message or --verified-message-deleted after inspecting Discord');
                    state.saveQuiz({ ...quiz, state: 'IDLE' });
                }
            }
        } finally { state?.close(); release(); } return;
    }
    console.log('Commands: status | initial --dry-run | monthly --dry-run | initial/monthly --commit --confirm ID --bot-stopped --accept-extraction-time | retry-upload --bot-stopped | verify | restore | redact | quiz-attach | quiz-reset');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
