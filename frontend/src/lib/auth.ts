import "server-only";
import { getCurrentUser } from "@/lib/session";

export { getCurrentUser };

/**
 * The signed-in user's email, or null for guests, who only see the shared
 * sample data. Pages pass this to the queries in lib/emails.ts, which scope
 * everything with `visibleOwners`.
 */
export async function getCurrentUserEmail(): Promise<string | null> {
  return (await getCurrentUser())?.email ?? null;
}
