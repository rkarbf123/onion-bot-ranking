import { useEffect, useState } from 'react';
import type { Entry, Snapshot } from '../types';
const base = `${import.meta.env.BASE_URL}data/`;
async function json(file: string, signal: AbortSignal) {
  const response = await fetch(base + file, { signal, cache: 'no-cache' });
  if (!response.ok) throw new Error('기록을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.');
  return response.json();
}
export function useIndex(reload: number) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    json('index.json', controller.signal).then(data => {
      if (data.schemaVersion !== 1 || !Array.isArray(data.archives)) throw new Error('지원하지 않는 기록 형식입니다.');
      for (const e of data.archives) if (!/^(\d{4}-\d{2}|2026-initial)$/.test(e.id) || e.path !== `archives/${e.id}.json` || typeof e.title !== 'string' || !Number.isFinite(Date.parse(e.snapshotAt))) throw new Error('기록 목록이 올바르지 않습니다.');
      setEntries([...data.archives].sort((a, b) => b.snapshotAt.localeCompare(a.snapshotAt)));
    }).catch(e => { if (e.name !== 'AbortError') setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);
  return { entries, loading, error };
}
export function useArchive(entry: Entry | undefined, reload: number) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError('');
    if (!entry) { setLoading(false); return; }
    setLoading(true);
    json(entry.path, controller.signal).then(value => {
      if (value.schemaVersion !== 1 || value.id !== entry.id || !Array.isArray(value.rankings) || value.totalUsers !== value.rankings.length ||
        !['periodStart','periodEnd','snapshotAt'].every(k => Number.isFinite(Date.parse(value[k]))) ||
        value.rankings.some((r: Record<string, unknown>, i: number) => r.rank !== i + 1 || typeof r.userId !== 'string' || !Number.isSafeInteger(r.level) || !Number.isSafeInteger(r.totalXp))) throw new Error('기록 데이터가 올바르지 않습니다.');
      setData(value);
    }).catch(e => { if (e.name !== 'AbortError') setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [entry, reload]);
  return { data, loading, error };
}
