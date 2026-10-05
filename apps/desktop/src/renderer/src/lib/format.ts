const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** Sizes the way file managers show them: 19.6 GB, 512 MB. */
export function formatBytes(bytes: number): string {
  if (bytes >= 100 * GB) return `${Math.round(bytes / GB)} GB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** A rough time left: "40 s", "6 min", "1 h 5 min". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** Context sizes as people say them: 32K, 256K, 1M. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1024 * 1024) return `${Math.round(tokens / (1024 * 1024))}M`;
  if (tokens >= 1024) return `${Math.round(tokens / 1024)}K`;
  return String(tokens);
}

export function formatRate(tokensPerSecond: number | null): string {
  return tokensPerSecond === null
    ? '–'
    : `${tokensPerSecond.toFixed(tokensPerSecond < 10 ? 1 : 0)} tok/s`;
}
