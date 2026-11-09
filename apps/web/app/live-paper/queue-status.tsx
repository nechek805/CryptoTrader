'use client';
import { useEffect, useState } from 'react';
type Status = {
  enabled: boolean;
  healthy: boolean;
  lastTickAt: number;
  counts: Record<string, number>;
};
export function QueueStatus() {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      try {
        const response = await fetch('/api/queue-status', {
          cache: 'no-store',
          signal: AbortSignal.timeout(6000),
        });
        if (!response.ok) return;
        const next = (await response.json()) as Status;
        if (!stopped) setStatus(next);
      } catch {
        /* Main workspace reports service failures. */
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 10000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  if (!status?.enabled) return null;
  return (
    <p role="status">
      BullMQ · {status.healthy ? 'Worker healthy' : 'Worker needs attention'}
      {' · '}
      {status.counts.active ?? 0} active · {status.counts.waiting ?? 0} waiting ·{' '}
      {status.counts.failed ?? 0} failed
      {status.lastTickAt > 0 && (
        <> · Last tick {new Date(status.lastTickAt).toISOString().slice(11, 19)} UTC</>
      )}
    </p>
  );
}
