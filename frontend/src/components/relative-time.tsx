'use client';

import { useEffect, useState } from "react";
import { timeAgo } from "@/lib/format";

/**
 * "3 min ago", filled in after mount and kept fresh -- same pattern as
 * components/inbox-screen.tsx's LastSynced. Rendering this during the initial render (server or
 * client) would call the impure Date.now()/relies on "now", which the React compiler's purity
 * rule (react-hooks/purity) rejects and which wouldn't match between server and client anyway.
 */
export function RelativeTime({ iso }: { iso: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(tick);
    };
  }, []);

  if (now === null) return null;
  return <>{timeAgo(now - Date.parse(iso))}</>;
}
