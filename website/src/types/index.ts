export interface Entry {
  id: string; type: 'initial' | 'monthly'; month: string | null; title: string;
  snapshotAt: string; totalUsers: number; path: string;
}
export interface Ranking { rank: number; userId: string; username: string; avatarUrl?: string | null; level: number; xp: number; totalXp: number }
export interface Snapshot extends Entry {
  schemaVersion: 1; periodStart: string; periodEnd: string; accuracy: string; partialPeriod: boolean;
  rankings: Ranking[];
}
