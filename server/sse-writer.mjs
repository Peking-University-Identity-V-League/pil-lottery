// Coalesce blocked state updates; never grow an unbounded per-viewer write queue.
export function createSseWriter(res, { maxBufferedBytes = 64 * 1024, slowClientTimeoutMs = 30000 } = {}) {
  let blocked = false;
  let pending = null;
  let timer = null;
  const frame = (event, json) => 'event: ' + event + '\ndata: ' + json + '\n\n';
  const stopTimer = () => { clearTimeout(timer); timer = null; };
  const alive = () => !res.destroyed && !res.writableEnded;
  function write(text) {
    if (!alive()) return;
    if (Buffer.byteLength(text) + res.writableLength > maxBufferedBytes) { res.destroy(); return; }
    if (!res.write(text)) {
      blocked = true;
      timer = setTimeout(() => res.destroy(), slowClientTimeoutMs);
      timer.unref?.();
    }
  }
  function drain() {
    stopTimer();
    blocked = false;
    const latest = pending;
    pending = null;
    if (latest) write(latest);
  }
  res.on('drain', drain);
  res.once('close', () => { stopTimer(); pending = null; res.off('drain', drain); });
  return {
    res,
    send(event, data, serialized = false) {
      if (!alive()) return;
      const text = frame(event, serialized ? data : JSON.stringify(data));
      if (Buffer.byteLength(text) > maxBufferedBytes) { res.destroy(); return; }
      if (blocked) {
        if (event === 'state') pending = text;
        return;
      }
      write(text);
    },
    close() {
      pending = null;
      if (!alive()) return;
      if (blocked || res.writableLength) res.destroy();
      else res.end(frame('closed', '{}'));
    },
  };
}
