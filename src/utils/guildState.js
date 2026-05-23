let recoveryComplete = false;
let recoveryResolve;

const recoveryReady = new Promise((resolve) => {
  recoveryResolve = resolve;
});

const guildLocks = new Map();

/** Marks recovery as complete and resolves the recovery promise. */
export function completeRecovery() {
  recoveryComplete = true;
  recoveryResolve?.();
}

/** Waits for recovery to complete before proceeding. */
export async function waitForRecovery() {
  if (!recoveryComplete) {
    await recoveryReady;
  }
}

/** Executes a function with a per-guild mutex lock. */
export async function withGuildLock(guildId, fn) {
  const previous = guildLocks.get(guildId) || Promise.resolve();
  let release;
  const current = previous.then(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  guildLocks.set(guildId, current);

  try {
    await previous;
    return await fn();
  } finally {
    release();
    if (guildLocks.get(guildId) === current) {
      guildLocks.delete(guildId);
    }
  }
}
