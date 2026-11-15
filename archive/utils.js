'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const hash = value => createHash('sha256').update(value).digest('hex');
function writeJson(file, value, exclusive = false) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = JSON.stringify(value, null, 2) + '\n';
    if (exclusive) {
        const fd=fs.openSync(file,'wx');
        try{fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
        return;
    }
    const temp = `${file}.tmp`;
    const fd = fs.openSync(temp, 'w');
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
}
function monthOf(time) { return new Date(new Date(time).getTime() + 9 * 3600000).toISOString().slice(0, 7); }
function monthEnd(month) {
    const [y, m] = month.split('-').map(Number);
    return new Date(Date.UTC(y, m, 1) - 9 * 3600000).toISOString();
}
function integrity(db) {
    const rows = db.prepare('PRAGMA integrity_check').all();
    if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') throw new Error('SQLite integrity_check failed');
}
function fingerprint(db, resetUsers = false) {
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const tables = {};
    for (const row of schema.filter(r => r.type === 'table')) {
        const name = '"' + row.name.replaceAll('"', '""') + '"';
        tables[row.name] = db.prepare(`SELECT * FROM ${name}`).all().map(r => {
            if (resetUsers && row.name === 'users') Object.assign(r,{xp:0,level:1,weekly_xp:0,item1:0,item2:0,item3:0,item4:0,item5:0});
            return JSON.stringify(r);
        }).sort();
    }
    return hash(JSON.stringify({ schema, tables }));
}
function acquireLock(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'runtime.lock');
    try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' }); }
    catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let owner;
        try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); process.kill(owner.pid, 0); }
        catch (probe) {
            if (probe.code === 'ESRCH') { fs.unlinkSync(file); return acquireLock(dir); }
            throw new Error('Cannot verify runtime.lock owner; inspect the lock before continuing');
        }
        throw new Error(`Bot/CLI already running (PID ${owner.pid}). Stop it before this operation.`);
    }
    return () => { if (fs.existsSync(file)) fs.unlinkSync(file); };
}
module.exports = { hash, writeJson, monthOf, monthEnd, integrity, fingerprint, acquireLock };
