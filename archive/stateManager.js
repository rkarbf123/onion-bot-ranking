'use strict';
const fs = require('node:fs');
const path = require('node:path');
class StateManager {
    constructor(Database, file, { readonly = false } = {}) {
        if (!readonly) fs.mkdirSync(path.dirname(file), { recursive: true });
        this.file = file;
        this.db = new Database(file, { readonly, fileMustExist: readonly });
        if (!readonly) {
            this.db.pragma('journal_mode = DELETE');
            this.db.pragma('synchronous = FULL');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS settlements (id TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS quiz (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS xp_events (id TEXT PRIMARY KEY, at INTEGER NOT NULL, value TEXT NOT NULL, applied INTEGER NOT NULL DEFAULT 0);
                CREATE INDEX IF NOT EXISTS xp_events_pending ON xp_events(applied,at);
            `);
        }
    }
    get(key) { const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
    set(key, value) { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
    settlement(id) { const row = this.db.prepare('SELECT value FROM settlements WHERE id=?').get(id); return row ? JSON.parse(row.value) : null; }
    saveSettlement(value) { this.db.prepare('INSERT INTO settlements VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.id, JSON.stringify(value)); }
    settlements() { return this.db.prepare('SELECT value FROM settlements ORDER BY id').all().map(r => JSON.parse(r.value)); }
    quiz() { const r = this.db.prepare('SELECT value FROM quiz WHERE id=1').get(); return r ? JSON.parse(r.value) : null; }
    saveQuiz(value) { this.db.prepare('INSERT INTO quiz VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(value)); }
    close() { this.db.close(); }
}
module.exports = StateManager;
