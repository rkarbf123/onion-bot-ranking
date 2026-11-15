'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { integrity, fingerprint, monthOf, monthEnd, writeJson } = require('./utils');
const { createSnapshot } = require('./snapshot');
const { applyEvent } = require('./xpEvents');

// All XP mutations and rollover are synchronous on the owning event loop. Never await in run().
class DatabaseManager {
    constructor({ Database, dbFile, state, directory, names = () => ({}), env = process.env, fault = () => {}, clock = Date.now }) {
        Object.assign(this, { Database, dbFile, state, directory, names, env, fault, clock });
        this.depth = 0;
        this.recoverSwitch();
        this.open();
        this.db = new Proxy({}, { get: (_, prop) => {
            if (prop === 'prepare') return sql => new Proxy({}, { get: (__, method) => (...args) => this.handle.prepare(sql)[method](...args) });
            if (prop === 'transaction') return fn => (...args) => this.run(() => this.handle.transaction(fn)(...args));
            const value = this.handle[prop];
            return typeof value === 'function' ? value.bind(this.handle) : value;
        } });
    }
    open() {
        this.handle = new this.Database(this.dbFile);
        this.handle.pragma('journal_mode = DELETE');
        this.handle.pragma('synchronous = FULL');
        // A rollback super-journal makes XP + persistent quiz state one atomic commit.
        this.handle.prepare('ATTACH DATABASE ? AS system').run(this.state.file);
        this.handle.pragma('system.journal_mode = DELETE');
        this.handle.pragma('system.synchronous = FULL');
    }
    run(fn, at = this.clock()) {
        if (!this.depth) this.ensurePeriod(at);
        this.depth++;
        try {
            const value = fn(this.handle);
            if (value && typeof value.then === 'function') throw new Error('DatabaseManager.run callback must be synchronous');
            return value;
        } finally { this.depth--; }
    }
    ensurePeriod(at = this.clock()) {
        if (!this.handle?.open && this.state.get('switch')) { this.recoverSwitch(); this.open(); }
        if (!this.processing) this.drainEvents();
        let current = this.state.get('currentPeriod');
        while (current && at >= Date.parse(monthEnd(current.month))) {
            // Downtime is not reconstructable: label the actual extraction boundary honestly.
            const scheduledEnd=monthEnd(current.month);
            const delayed=at-Date.parse(scheduledEnd)>60000;
            this.rollover({ id: current.month, start: current.start, end: delayed ? new Date(at).toISOString() : scheduledEnd,
                snapshotAt: new Date(at).toISOString(), scheduledEnd: monthEnd(current.month),
                accuracy: delayed ? 'delayed-extraction' : 'live-boundary' });
            current = this.state.get('currentPeriod');
        }
    }
    recordXp(event) {
        this.state.db.prepare('INSERT OR IGNORE INTO xp_events(id,at,value) VALUES (?,?,?)').run(event.id,event.at,JSON.stringify(event));
        this.drainEvents();
        const row = this.state.db.prepare('SELECT value FROM xp_events WHERE id=?').get(event.id);
        return JSON.parse(row.value).result;
    }
    drainEvents() {
        if (this.processing) return;
        this.processing = true;
        try {
            for (const row of this.state.db.prepare('SELECT id,value FROM xp_events WHERE applied=0 ORDER BY at,rowid').all()) {
                const event = JSON.parse(row.value);
                this.ensurePeriod(event.at);
                this.handle.transaction(() => {
                    const result = applyEvent(this.handle,event);
                    this.handle.prepare('UPDATE system.xp_events SET applied=1,value=? WHERE id=?').run(JSON.stringify({...event,result}),event.id);
                })();
            }
        } finally { this.processing = false; }
    }
    safeBackup(destination) {
        if (fs.existsSync(destination)) throw new Error(`Refusing to overwrite backup: ${destination}`);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const before = fingerprint(this.handle);
        // VACUUM INTO is a consistent SQLite snapshot, including committed WAL data.
        this.handle.prepare('VACUUM main INTO ?').run(destination);
        const backup = new this.Database(destination, { readonly: true, fileMustExist: true });
        try {
            integrity(backup);
            if (fingerprint(backup) !== before || fingerprint(this.handle) !== before) throw new Error('Backup/source mismatch');
        } finally { backup.close(); }
        return before;
    }
    rollover(period, { initial = false, beforeSwitch = null } = {}) {
        if (!this.processing) this.drainEvents();
        if (this.depth) throw new Error('Cannot rotate during an XP transaction');
        const existing = this.state.settlement(period.id);
        if (existing?.switched) return existing;
        period=existing?.period || period;
        if (this.state.get('switch')) throw new Error('Unfinished DB switch; restart to recover before continuing');
        const backup = path.join(this.directory, 'backups', `levels_${period.id}.old.db`);
        const next = this.dbFile + '.next.db';
        let job = existing || { id: period.id, period, status: 'PENDING', uploaded: false, switched: false };
        job.names = job.names || this.names();
        this.state.saveSettlement(job);
        try {
            integrity(this.handle);
            const sourceHash = fingerprint(this.handle);
            if (job.sourceHash && job.sourceHash !== sourceHash) throw new Error('Source changed after interrupted settlement; manual review required');
            job.sourceHash = sourceHash;
            if (fs.existsSync(backup)) {
                // Only a recorded backup belonging to this settlement may be reused.
                if (!job.backup) throw new Error('Unowned backup exists; refusing overwrite');
                this.verifyFile(backup, sourceHash);
            } else {
                job.backup = backup;
                this.state.saveSettlement(job);
                this.safeBackup(backup);
            }
            job.backup = backup; job.status = 'BACKED_UP'; this.state.saveSettlement(job); this.fault('BACKED_UP');
            const names = job.names;
            const privateSnapshot = createSnapshot(this.handle, period, { names });
            const publicSnapshot = createSnapshot(this.handle, period, { names, publicOnly: true, env: this.env });
            const privateFile = path.join(this.directory, 'private', `${period.id}.json`);
            const publicFile = path.join(this.directory, 'snapshots', `${period.id}.json`);
            for (const [file, data] of [[privateFile, privateSnapshot], [publicFile, publicSnapshot]]) {
                if (fs.existsSync(file)) {
                    if (JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))) !== JSON.stringify(data)) throw new Error('Existing snapshot differs; review required');
                } else writeJson(file, data, true);
            }
            job.snapshot = publicFile; job.privateSnapshot = privateFile; job.status = 'SNAPSHOTTED';
            this.state.saveSettlement(job); this.fault('SNAPSHOTTED');
            if (beforeSwitch) return { ...job, awaitingUpload: true };
            if (initial && !job.uploaded) throw new Error('Initial settlement requires verified upload before DB reset');
            const expectedNext = fingerprint(this.handle, true);
            if (fs.existsSync(next) && job.candidate !== next) throw new Error('An unowned candidate DB exists; inspect it before retry');
            job.candidate=next;this.state.saveSettlement(job);
            if (!fs.existsSync(next)) this.handle.prepare('VACUUM main INTO ?').run(next);
            this.fault('CANDIDATE_CREATED');
            const fresh = new this.Database(next);
            let nextHash;
            try {
                fresh.pragma('journal_mode = DELETE'); fresh.pragma('synchronous = FULL');
                const candidateHash=fingerprint(fresh);
                if(candidateHash!==sourceHash && candidateHash!==expectedNext) throw new Error('Candidate DB differs from recorded source/reset state; preserve and inspect it');
                fresh.prepare('UPDATE users SET xp=0,level=1,weekly_xp=0,item1=0,item2=0,item3=0,item4=0,item5=0').run();
                integrity(fresh);
                const oldSettings = this.handle.prepare('SELECT * FROM settings ORDER BY key').all();
                if (JSON.stringify(fresh.prepare('SELECT * FROM settings ORDER BY key').all()) !== JSON.stringify(oldSettings)) throw new Error('Settings changed');
                nextHash = fingerprint(fresh);
                if(nextHash!==expectedNext)throw new Error('Reset candidate differs from expected data');
            } finally { fresh.close(); }
            this.fault('CANDIDATE_RESET');
            const switchedAt = new Date(this.clock()).toISOString();
            const nextStart=initial ? switchedAt : period.end;
            const nextPeriod = { month: monthOf(nextStart), start: nextStart };
            const swap = { id: period.id, next, nextHash, retired: path.join(this.directory, 'backups', `levels_${period.id}.source.db`), nextPeriod, switchedAt };
            job.status = 'SWITCHING'; this.state.saveSettlement(job); this.state.set('switch', swap);
            this.fault('SWITCHING');
            this.handle.close(); this.handle = null;
            this.recoverSwitch();
            this.open();
            return this.state.settlement(period.id);
        } catch (error) {
            job.status = 'FAILED'; job.error = error.message; job.failedAt = new Date().toISOString();
            this.state.saveSettlement(job);
            // If a durable switch intent exists, no more writes are allowed until recovery.
            if (this.state.get('switch') && this.handle?.open) { this.handle.close(); this.handle = null; }
            throw error;
        }
    }
    verifyFile(file, expected) {
        const db = new this.Database(file, { readonly: true, fileMustExist: true });
        try { integrity(db); if (expected && fingerprint(db) !== expected) throw new Error('Database fingerprint mismatch'); }
        finally { db.close(); }
    }
    recoverSwitch() {
        const swap = this.state.get('switch');
        if (!swap) return;
        const job = this.state.settlement(swap.id);
        this.verifyFile(job.backup, job.sourceHash);
        if (fs.existsSync(swap.next)) {
            this.verifyFile(swap.next, swap.nextHash);
            if (fs.existsSync(this.dbFile)) {
                if (fs.existsSync(swap.retired)) throw new Error('Live and retired DB both exist; refusing overwrite');
                this.verifyFile(this.dbFile, job.sourceHash);
                fs.renameSync(this.dbFile, swap.retired);
            }
            this.fault('OLD_RENAMED');
            fs.renameSync(swap.next, this.dbFile);
        }
        this.verifyFile(this.dbFile, swap.nextHash);
        this.fault('NEW_RENAMED');
        this.state.db.transaction(() => {
            this.state.set('currentPeriod', swap.nextPeriod);
            this.state.set('initialCompleted', true);
            this.state.saveSettlement({ ...job, switched: true, switchedAt: swap.switchedAt || swap.nextPeriod.start, status: job.uploaded ? 'COMPLETED' : 'UPLOAD_PENDING', error: null });
            this.state.set('switch', null);
        })();
    }
    startupBackup(file) {
        const temp = file + '.next.db';
        // A previous startup backup is retained until its replacement has passed validation.
        if (fs.existsSync(temp)) throw new Error(`Unfinished startup backup: ${temp}`);
        this.safeBackup(temp);
        fs.renameSync(temp, file);
    }
    close() { if (this.handle?.open) this.handle.close(); }
}
module.exports = DatabaseManager;
