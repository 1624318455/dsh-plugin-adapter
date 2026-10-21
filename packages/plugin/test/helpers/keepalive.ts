/**
 * The adapter's watchdog deadline timer is unref'd on purpose: a pending
 * deadline must never hold the DSH process open. A test that waits for that
 * deadline therefore has to keep the event loop alive itself — otherwise the
 * loop drains and the test runner reports "Promise resolution is still
 * pending but the event loop has already resolved" (Node 22; Node 24 happens
 * to survive it).
 */
export async function withKeepAlive<T>(fn: () => Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => {}, 20)
  try {
    return await fn()
  } finally {
    clearInterval(keepAlive)
  }
}
