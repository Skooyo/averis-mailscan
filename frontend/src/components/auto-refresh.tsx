"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-renders the current server page while `active`, so things that change in the background
 * (emails arriving, being classified) show up without a manual reload. Polls quickly at first
 * (new mail appears about a second after it's saved), then eases off, and gives up after `maxMs`
 * so a stuck job can't keep the page polling forever.
 *
 * It never has two refreshes in flight: the next one is only scheduled once the previous has
 * landed. (A new refresh replaces one still running, so polling faster than the page can render
 * would mean none of them ever finished.)
 */
export function AutoRefresh({
  active,
  fastEveryMs = 1000,
  fastForMs = 10_000,
  everyMs = 3000,
  maxMs = 5 * 60_000,
}: {
  active: boolean;
  fastEveryMs?: number;
  fastForMs?: number;
  everyMs?: number;
  maxMs?: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition(); // true from the refresh being requested until it has landed
  const startedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      startedAt.current = null;
      return;
    }
    if (pending) return; // wait for the refresh in flight; this effect runs again when it lands
    if (startedAt.current === null) startedAt.current = Date.now();
    const age = Date.now() - startedAt.current;
    if (age > maxMs) return;

    const timer = setTimeout(() => startTransition(() => router.refresh()), age < fastForMs ? fastEveryMs : everyMs);
    return () => clearTimeout(timer);
  }, [active, pending, fastEveryMs, fastForMs, everyMs, maxMs, router]);

  return null;
}
