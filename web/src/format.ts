/** SQLite stores UTC 'YYYY-MM-DD HH:MM:SS'; show it in local time. */
export function fmtTime(s: string | null | undefined): string {
  if (!s) return '—';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}
