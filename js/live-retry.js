// Equal jitter prevents synchronized reconnects while retaining a bounded wait.
export function reconnectDelay(attempt, random = Math.random, minimumMs = 0) {
  const cap = Math.min(30000, 1000 * 2 ** Math.min(5, Math.max(0, attempt)));
  return Math.max(minimumMs, Math.round(cap * (0.5 + random() * 0.5)));
}

export function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, Math.min(delay, 10 * 60 * 1000)) : 0;
}
