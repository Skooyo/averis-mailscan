import { SHARED_OWNER } from "@/lib/constants";

/**
 * The `owner` / `user_email` values a user may read: always the shared demo
 * dataset, plus their own emails when they're signed in. Every query on the
 * emails or attachments collections should filter with this.
 *
 * `userEmail` must come from the verified session, never from a request
 * parameter. Only real addresses count as a user, so a value without an "@"
 * (including SHARED_OWNER itself) can't be used to claim anyone's data.
 */
export function visibleOwners(userEmail: string | null | undefined): string[] {
  const email = userEmail?.trim().toLowerCase();
  return email && email.includes("@") ? [SHARED_OWNER, email] : [SHARED_OWNER];
}
