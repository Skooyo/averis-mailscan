import "server-only";
import { encrypt } from "@/lib/crypto";
import { connectDB } from "@/lib/mongodb";
import { User } from "@/models/User";

/**
 * Creates or updates the user for a verified Google sign-in.
 * Google only returns a refresh token the first time someone grants access (or
 * when consent is re-prompted), so an existing stored token is kept when
 * `refreshToken` is absent. Returns whether we now hold a refresh token.
 */
export async function saveGoogleUser(input: {
  email: string;
  name?: string | null;
  refreshToken?: string | null;
  scope?: string | null;
}): Promise<{ hasRefreshToken: boolean }> {
  await connectDB();

  const update: Record<string, string> = {};
  if (input.name) update.name = input.name;
  if (input.scope) update.google_scope = input.scope;
  if (input.refreshToken) update.google_refresh_token = encrypt(input.refreshToken);

  const user = await User.findOneAndUpdate(
    { email: input.email.toLowerCase() },
    {
      $set: update,
      // A fresh token (first sign-in, or the user reconnecting) clears any earlier sync failure
      // and the throttle, so the next inbox load syncs straight away.
      ...(input.refreshToken && { $unset: { sync_error: 1, last_synced_at: 1 } }),
    },
    { upsert: true, returnDocument: "after", runValidators: true },
  ).select("+google_refresh_token");

  return { hasRefreshToken: Boolean(user?.google_refresh_token) };
}
