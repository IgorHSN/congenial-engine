import { IMAGE_PROTOCOL } from '@shared/ipc';

export const api = window.atelier;

export function imageUrl(path: string): string {
  return `${IMAGE_PROTOCOL}://local/?p=${encodeURIComponent(path)}`;
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '?';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
