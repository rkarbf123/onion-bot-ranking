'use strict';
const schedule = require('node-schedule');
function startScheduler(manager, uploader, state) {
    let stopped = false; let inFlight = null;
    const tick = () => {
        if (stopped) return;
        try { manager.ensurePeriod(); }
        catch (error) { console.error('정산 복구 필요:', error.message); }
        if (!inFlight) inFlight = uploader.retry(state).catch(error => console.error('업로드 오류:', error.message)).finally(() => { inFlight = null; });
    };
    const rule = new schedule.RecurrenceRule();
    rule.tz = 'Asia/Seoul'; rule.date = 1; rule.hour = 0; rule.minute = 0; rule.second = 0;
    const job = schedule.scheduleJob(rule, tick);
    const retryTimer = setInterval(tick, 60000);
    tick();
    return async () => { stopped = true; job.cancel(); clearInterval(retryTimer); if (inFlight) await inFlight; };
}
module.exports = { startScheduler };
