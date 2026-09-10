export type ScanRunGuard = {
  tryAcquire: () => boolean;
  release: () => void;
  isInProgress: () => boolean;
};

export function createScanRunGuard(): ScanRunGuard {
  let inProgress = false;
  return {
    tryAcquire() {
      if (inProgress) return false;
      inProgress = true;
      return true;
    },
    release() {
      inProgress = false;
    },
    isInProgress() {
      return inProgress;
    },
  };
}

export async function withConsoleTimer<T>(
  label: string,
  operation: () => Promise<T>,
  timer: Pick<Console, "time" | "timeEnd"> = console,
): Promise<T> {
  timer.time(label);
  try {
    return await operation();
  } finally {
    timer.timeEnd(label);
  }
}
