import { useEffect, useMemo, useState } from 'react';
import { useArchive, useIndex } from './hooks/useArchive';
import Avatar from './components/Avatar';
import './style.css';
const number = new Intl.NumberFormat('ko-KR');
const date = (value: string) => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'medium', timeStyle: 'short' });
function hashId() { try { return decodeURIComponent(location.hash.slice(1)); } catch { return ''; } }
export default function App() {
  const [reload, setReload] = useState(0);
  const { entries, loading: indexLoading, error: indexError } = useIndex(reload);
  const [selected, setSelected] = useState(hashId);
  const [query, setQuery] = useState(''); const [page, setPage] = useState(1); const [ascending, setAscending] = useState(true);
  useEffect(() => { const handler = () => setSelected(hashId()); window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler); }, []);
  const entry = entries.find(e => e.id === selected) || (!selected ? entries[0] : undefined);
  const { data, loading, error } = useArchive(entry, reload);
  const choose = (id: string) => { location.hash = id; setSelected(id); setQuery(''); setPage(1); };
  useEffect(() => { setPage(1); }, [selected, query, ascending]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const rows = (data?.rankings || []).filter(r => (r.username || '').toLocaleLowerCase().includes(needle) || r.userId.includes(needle));
    return ascending ? rows : [...rows].reverse();
  }, [data, query, ascending]);
  const pages = Math.max(1, Math.ceil(filtered.length / 25)); const safePage = Math.min(page, pages);
  const years = [...new Set(entries.map(e => e.snapshotAt.slice(0, 4)))].sort().reverse();
  const initial = entries.find(e => e.type === 'initial');
  const failure = indexError || error || (selected && !entry && !indexLoading ? '해당 기록을 찾을 수 없습니다.' : '');
  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="#" onClick={() => choose('')}><span className="brand-mark">🧅</span><span>양파봇 <b>랭킹</b></span></a><span className="archive-label"><span /></span></header>
    <div className="workspace">
      <aside className="sidebar"><p className="sidebar-description">매달의 활동을 한눈에.<br />누적 경험치 순위를 모아두었어요.</p>
        <div className="shortcuts"><button onClick={() => entries[0] && choose(entries[0].id)} disabled={!entries.length}>↗ 최신 기록</button><button onClick={() => initial && choose(initial.id)} disabled={!initial}>◷ 최초 기록</button></div>
        <nav aria-label="연도별 기록">{years.map(year => <section key={year} className="year-group"><h2>{year}<span>{entries.filter(e => e.snapshotAt.startsWith(year)).length}</span></h2>{entries.filter(e => e.snapshotAt.startsWith(year)).map(e => <button className={`archive-link ${entry?.id === e.id ? 'selected' : ''}`} key={e.id} onClick={() => choose(e.id)}><span>{e.type === 'initial' ? '최초 누적 기록' : `${Number(e.month?.slice(5))}월 랭킹`}</span><span>↗</span></button>)}</section>)}</nav>
        <div className="sidebar-note"><span>ⓘ</span><p>매월 1일, 지난 기간의 랭킹이<br />새로운 기록으로 보관됩니다.</p></div>
      </aside>
      <main>
        <div className="breadcrumb">기록 보관함 <span>/</span> {entry?.type === 'initial' ? '최초 누적 기록' : entry?.month || '월별 랭킹'}</div>
        <div className="page-heading"><div><p className="eyebrow accent">월간 랭킹</p><h2>{entry?.title || '누적 경험치 순위'}</h2><p></p></div><span className="record-badge">◉ 확정 기록</span></div>
        <label className="mobile-selector">기록 선택<select value={entry?.id || ''} onChange={e => choose(e.target.value)}><option value="" disabled>기록 선택</option>{entries.map(e => <option key={e.id} value={e.id}>{e.title}</option>)}</select></label>
        {failure ? <div role="alert" className="empty-state"><span>↻</span><h3>{failure}</h3><button className="button" onClick={() => setReload(r => r + 1)}>다시 불러오기</button>{selected && !entry && <button className="button" onClick={() => choose('')}>최신 기록으로</button>}</div>
        : indexLoading || loading ? <div role="status" className="empty-state"><span className="loading-dot" /><p>기록을 불러오고 있어요.</p></div>
        : !data ? <div className="empty-state"><span>◷</span><h3>아직 보관된 기록이 없어요</h3><p>첫 번째 정산이 완료되면 이곳에서 랭킹을 확인할 수 있어요.</p></div>
        : <>
          <div className="stats-grid"><div className="stat"><span>기록에 포함된 사용자</span><strong>{number.format(data.totalUsers)}<small>명</small></strong><span className="stat-foot">이 기간의 공개 랭킹</span></div><div className="stat"><span>전체 누적 경험치</span><strong>{number.format(data.rankings.reduce((sum, r) => sum + r.totalXp, 0))}<small>XP</small></strong><span className="stat-foot">공개된 사용자 기준</span></div><div className="stat"><span>정산 기록 시각</span><strong className="date-stat">{date(data.snapshotAt)}</strong><span className="stat-foot">한국 표준시 · KST</span></div></div>
          <div className="period-note">집계 기간: {date(data.periodStart)} ~ {date(data.periodEnd)} (종료 시각 미포함){data.accuracy !== 'live-boundary' && <span> · 실제 추출 시각 기준{data.accuracy === 'delayed-extraction' ? ' · 정산 지연으로 여러 달의 활동이 포함될 수 있습니다.' : ''}</span>}</div>
          <section className="ranking-panel" aria-label="XP 랭킹"><div className="table-toolbar"><div><h3>전체 랭킹 <span>{number.format(data.totalUsers)}</span></h3><p>총 경험치가 높은 순서로 기록했어요.</p></div><label className="search"><span>⌕</span><input aria-label="사용자 이름 또는 Discord ID 검색" value={query} onChange={e => setQuery(e.target.value)} placeholder="사용자 이름 또는 Discord ID" /></label></div>
            <div className="table-scroll"><table><thead><tr><th><button onClick={() => setAscending(v => !v)} aria-label="순위 정렬 변경">순위 {ascending ? '↓' : '↑'}</button></th><th>사용자</th><th>레벨</th><th className="xp">전체 XP</th></tr></thead><tbody>{filtered.slice((safePage - 1) * 25, safePage * 25).map(row => <tr key={row.userId}><td><span className={`rank rank-${row.rank <= 3 ? row.rank : 'normal'}`}>{String(row.rank).padStart(2, '0')}</span></td><td><div className="user-cell"><Avatar key={row.userId} row={row} /><div><strong>{row.username || `사용자 ${row.userId}`}</strong><small>{row.userId}</small></div></div></td><td><span className="level">Lv. {row.level}</span></td><td className="xp"><strong>{number.format(row.totalXp)}</strong><span> XP</span></td></tr>)}</tbody></table></div>
            {!filtered.length && <div className="no-results">{query ? '검색 결과가 없습니다.' : '공개된 사용자 기록이 없습니다.'}</div>}
            <div className="pagination"><span>{filtered.length ? `${(safePage - 1) * 25 + 1}–${Math.min(safePage * 25, filtered.length)}` : '0'} / {number.format(filtered.length)}명</span><div><button disabled={safePage === 1} onClick={() => setPage(safePage - 1)} aria-label="이전 페이지">←</button><span>{safePage} / {pages}</span><button disabled={safePage === pages} onClick={() => setPage(safePage + 1)} aria-label="다음 페이지">→</button></div></div>
          </section>
        </>}
        <footer><span>🧅 양파봇 랭킹</span><p>확정된 기록만 표시됩니다. 공개 제외·비공개·삭제 요청은 서버 내 문의하기 채널이나 개인 메시지로 문의해주세요.</p></footer>
      </main>
    </div>
  </div>;
}