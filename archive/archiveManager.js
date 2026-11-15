'use strict';
const path = require('node:path');
const Database = require('better-sqlite3');
const StateManager = require('./stateManager');
const DatabaseManager = require('./databaseManager');
const { acquireLock } = require('./utils');
function openRuntime({ root = path.resolve(__dirname, '..'), names, env = process.env } = {}) {
    const directory = path.join(root, 'archive');
    const release = acquireLock(directory);
    let state; let manager;
    try {
        state = new StateManager(Database, path.join(directory, 'system_state.db'));
        manager = new DatabaseManager({ Database, dbFile: path.join(root, 'levels.db'), directory, state, names, env });
        return { state, manager, close() { manager.close(); state.close(); release(); } };
    } catch (error) { manager?.close(); state?.close(); release(); throw error; }
}
module.exports = { openRuntime };
