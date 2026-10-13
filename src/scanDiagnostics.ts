export type ProviderRequestMetrics = {
  requestCount: number;
  retryRequestCount: number;
  failedRequestCount: number;
  requestDurationMs: number;
};

export function createProviderRequestMetrics(): ProviderRequestMetrics {
  return { requestCount: 0, retryRequestCount: 0, failedRequestCount: 0, requestDurationMs: 0 };
}

/** Measure one actual provider attempt with a monotonic clock; rethrows unchanged. */
export async function measureProviderRequest<T>(
  metrics: ProviderRequestMetrics,
  request: () => Promise<T>,
  retry = false,
  monotonicNow: () => number = () => performance.now(),
): Promise<T> {
  metrics.requestCount += 1;
  if (retry) metrics.retryRequestCount += 1;
  const startedAt = monotonicNow();
  try {
    return await request();
  } catch (error) {
    metrics.failedRequestCount += 1;
    throw error;
  } finally {
    metrics.requestDurationMs += Math.max(0, monotonicNow() - startedAt);
  }
}

export function roundedDurationMs(durationMs: number): number {
  return Math.max(0, Math.round(Number.isFinite(durationMs) ? durationMs : 0));
}
