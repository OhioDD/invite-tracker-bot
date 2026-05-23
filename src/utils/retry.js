const MAX_ATTEMPTS = 3;

const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED',
  'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  '40P01', '40001', '55P03', '57014'
]);

/** Checks if an error is transient/retryable by code or message. */
function isTransient(err) {
  if (!err) return false;
  if (TRANSIENT_CODES.has(err.code)) return true;
  const msg = (err.message || '').toLowerCase();
  return msg.includes('timeout') || msg.includes('econnreset') || msg.includes('etimedout');
}

/** Retries a function with exponential backoff for transient errors. */
export async function withRetry(fn, label = 'db op', attempt = 1) {
  try {
    return await fn();
  } catch (err) {
    if (!isTransient(err) || attempt >= MAX_ATTEMPTS) {
      throw err;
    }
    const wait = Math.min(100 * 2 ** attempt, 2000);
    console.warn(`${label} failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${wait}ms: ${err.message}`);
    await new Promise((resolve) => {
      setTimeout(resolve, wait);
    });
    return withRetry(fn, label, attempt + 1);
  }
}
