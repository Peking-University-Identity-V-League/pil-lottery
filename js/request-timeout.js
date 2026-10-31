// Use the native deadline when available; Safari/iPadOS 15 needs a fallback.
// The scope includes response parsing, not only receipt of HTTP headers.
export async function withRequestTimeout(timeoutMs, operation) {
  async function run(signal) {
    try {
      return await operation(signal);
    } catch (error) {
      // Older implementations can reject timed-out fetches with AbortError.
      if (signal.aborted) throw new DOMException('Request timed out', 'TimeoutError');
      throw error;
    }
  }
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return run(AbortSignal.timeout(timeoutMs));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
