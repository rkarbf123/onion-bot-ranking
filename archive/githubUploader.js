'use strict';
const fs = require('node:fs');
const { writeJson } = require('./utils');
const { validateSnapshot } = require('./snapshot');
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(v) { return Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v; }
class GitHubUploader {
    constructor({ env = process.env, fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
        this.env = env; this.fetch = fetchImpl; this.sleep = sleep;
        this.branch = env.GITHUB_BRANCH || 'main';
        this.base = `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER || '')}/${encodeURIComponent(env.GITHUB_REPO || '')}/contents/`;
        this.dataPath = (env.GITHUB_DATA_PATH || 'website/public/data').replace(/^\/+|\/+$/g, '');
    }
    preflight() {
        if (this.env.ARCHIVE_PUBLIC_UPLOAD !== 'true') throw new Error('Publication is disabled. Review scope and set ARCHIVE_PUBLIC_UPLOAD=true after approval.');
        for (const key of ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO']) if (!this.env[key]) throw new Error(`Missing ${key}`);
        if (!this.env.ARCHIVE_PUBLIC_USER_IDS && !this.env.ARCHIVE_PUBLIC_GUILD_IDS && !this.env.ARCHIVE_SCOPE_FILE) throw new Error('An explicit publication scope is required');
    }
    async request(file, options = {}) {
        const url = this.base + file.split('/').map(encodeURIComponent).join('/') + (options.method ? '' : `?ref=${encodeURIComponent(this.branch)}`);
        for (let attempt = 0; attempt < 3; attempt++) {
            let response;
            try {
                response = await this.fetch(url, { ...options, signal: AbortSignal.timeout(20000), headers: {
                    Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
                    'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', ...options.headers } });
            } catch (_) {
                if (attempt < 2) { await this.sleep(500 * 2 ** attempt); continue; }
                throw new Error('GitHub NETWORK failure (credentials redacted)');
            }
            if (response.status === 404 && !options.method) return null;
            if (response.ok) return response.json();
            const rateLimited = response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.get('retry-after')));
            if ((response.status >= 500 || rateLimited) && attempt < 2) {
                await this.sleep(Math.min(5000, Math.max(500 * 2 ** attempt, Number(response.headers.get('retry-after') || 0) * 1000))); continue;
            }
            const category = rateLimited ? 'RATE_LIMIT' : [401, 403].includes(response.status) ? 'AUTHORIZATION' : [409, 422].includes(response.status) ? 'CONFLICT' : 'HTTP';
            throw new Error(`GitHub ${category} (${response.status})`);
        }
    }
    async read(file) {
        const result = await this.request(file);
        if (!result) return null;
        if (!result.content || result.encoding !== 'base64') throw new Error('GitHub file cannot be verified via Contents API');
        return { sha: result.sha, value: JSON.parse(Buffer.from(result.content, 'base64').toString('utf8')) };
    }
    async put(file, value, current) {
        await this.request(file, { method: 'PUT', body: JSON.stringify({ message: `Archive: ${file}`, branch: this.branch,
            content: Buffer.from(JSON.stringify(value, null, 2) + '\n').toString('base64'), ...(current ? { sha: current.sha } : {}) }) });
        const verified = await this.read(file);
        if (!verified || !equal(verified.value, value)) throw new Error('Remote content verification failed');
    }
    async upload(snapshot, { privacyReplacement = false } = {}) {
        this.preflight(); validateSnapshot(snapshot);
        const file = `${this.dataPath}/archives/${snapshot.id}.json`;
        const current = await this.read(file);
        if (current && !equal(current.value, snapshot)) {
            if (!privacyReplacement) throw new Error(`Immutable archive differs: ${snapshot.id}`);
            const old = current.value;
            const metadata = s => Object.fromEntries(Object.entries(s).filter(([k]) => !['rankings','totalUsers'].includes(k)));
            if (!equal(metadata(old),metadata(snapshot)) || snapshot.rankings.some(r => {
                const previous = old.rankings.find(p => p.userId===r.userId);
                return !previous || !equal({...previous,rank:0},{...r,rank:0});
            })) throw new Error('Privacy replacement may only remove users and renumber ranks');
            await this.put(file,snapshot,current);
        }
        if (!current) await this.put(file, snapshot, null);
        const indexPath = `${this.dataPath}/index.json`;
        const entry = { id: snapshot.id, type: snapshot.type, month: snapshot.month, title: snapshot.title, snapshotAt: snapshot.snapshotAt,
            totalUsers: snapshot.totalUsers, path: `archives/${snapshot.id}.json` };
        for (let attempt = 0; attempt < 3; attempt++) {
            const remote = await this.read(indexPath);
            const index = remote?.value || { schemaVersion: 1, archives: [] };
            if (index.schemaVersion !== 1 || !Array.isArray(index.archives)) throw new Error('Invalid remote index');
            const old = index.archives.find(a => a.id === entry.id);
            if (old && !equal(old, entry) && !privacyReplacement) throw new Error('Existing index entry differs');
            if (old && equal(old,entry)) return;
            if (old) index.archives[index.archives.findIndex(a=>a.id===entry.id)] = entry;
            else index.archives.push(entry);
            index.archives.sort((a, b) => b.snapshotAt.localeCompare(a.snapshotAt));
            try { await this.put(indexPath, index, remote); return; }
            catch (error) { if (!error.message.includes('CONFLICT') || attempt === 2) throw error; }
        }
    }
    async retry(state) {
        for (const job of state.settlements().filter(j => j.snapshot && !j.uploaded)) {
            state.saveSettlement({ ...job, uploadStatus: 'UPLOADING' });
            try {
                let snapshot=JSON.parse(fs.readFileSync(job.snapshot, 'utf8'));
                if (job.privacyRemovals?.length) {
                    const rankings=snapshot.rankings.filter(r=>!job.privacyRemovals.includes(r.userId)).map((r,i)=>({...r,rank:i+1}));
                    snapshot={...snapshot,rankings,totalUsers:rankings.length};writeJson(job.snapshot,snapshot);
                }
                await this.upload(snapshot, {privacyReplacement:!!job.privacyReplacement});
                state.saveSettlement({ ...state.settlement(job.id), uploaded: true, uploadStatus: 'UPLOADED', status: job.switched ? 'COMPLETED' : 'UPLOADED', uploadError: null });
            } catch (error) {
                state.saveSettlement({ ...state.settlement(job.id), uploadStatus: 'FAILED', uploadError: error.message });
            }
        }
    }
}
module.exports = GitHubUploader;
