'use strict';
const path=require('node:path');const Database=require('better-sqlite3');const StateManager=require('../archive/stateManager');const DatabaseManager=require('../archive/databaseManager');
const [dbFile,directory,stage]=process.argv.slice(2);
const state=new StateManager(Database,path.join(directory,'system_state.db'));
const manager=new DatabaseManager({Database,dbFile,directory,state,env:{},clock:()=>Date.parse('2026-12-01T00:00:00+09:00'),fault:point=>{if(point===stage)process.exit(77);}});
manager.rollover({id:'2026-11',start:'2026-11-15T03:00:00+09:00',end:'2026-12-01T00:00:00+09:00',snapshotAt:'2026-12-01T00:00:00+09:00'});
manager.close();state.close();
