import { useState } from 'react';
import type { Ranking } from '../types';
export default function Avatar({ row }: { row: Ranking }) {
  const [failed, setFailed] = useState(false);
  const safe = row.avatarUrl?.startsWith('https://cdn.discordapp.com/');
  return <span className="avatar">{safe && !failed ? <img src={row.avatarUrl!} alt="" loading="lazy" onError={() => setFailed(true)} /> : (row.username || '사용자').slice(0, 1).toUpperCase()}</span>;
}
