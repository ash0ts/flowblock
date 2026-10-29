/** One deadline covers provider calls and optional tracing in both coordinators. */
export function createDeadline(milliseconds = 30_000, started = Date.now()) {
  if (
    !Number.isInteger(milliseconds) ||
    milliseconds < 1 ||
    milliseconds > 2_147_483_647
  ) {
    throw new Error(
      "Coordinator deadline must be a positive integer number of milliseconds.",
    );
  }
  const controller = new AbortController();
  const remaining = milliseconds - (Date.now() - started);
  const abort = () =>
    controller.abort(new Error("Coordinator deadline reached"));
  const timer = setTimeout(abort, Math.max(0, remaining));
  if (remaining <= 0) abort();
  return { signal: controller.signal, close: () => clearTimeout(timer) };
}

export function beforeDeadline<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Tracing failures must not discard a completed plan or revision. */
export function trace<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch {
    return undefined;
  }
}

export async function boundedTelemetry(
  operation: () => Promise<unknown>,
  signal: AbortSignal,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return !!(await beforeDeadline(
      () =>
        Promise.race([
          operation(),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), 1000);
          }),
        ]),
      signal,
    ));
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
