const MAX_ATTEMPTS = 3;

const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED',
  'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  '40P01', '40001', '55P03', '57014'
]);

function isTransient(err) {
  if (!err) return false;
  if (TRANSIENT_CODES.has(err.code)) return true;
  const msg = (err.message || '').toLowerCase();
  return msg.includes('timeout') || msg.includes('econnreset') || msg.includes('etimedout');
}

export async function withRetry(fn, label = 'db op') {
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === MAX_ATTEMPTS) break;

      const wait = Math.min(100 * 2 ** attempt, 2000);
      console.warn(`${label} failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${wait}ms: ${err.message}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  throw lastErr;
}
