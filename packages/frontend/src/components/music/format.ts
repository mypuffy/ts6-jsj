export function formatTime(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0 || !isFinite(seconds)) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function isUrl(s: string): boolean {
  return /^https?:\/\/\S+$/i.test(s);
}

export function totalDuration(items: { duration?: number | null }[]): number {
  return items.reduce((acc, it) => acc + (it.duration || 0), 0);
}
