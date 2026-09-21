import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth-shared";
import { randomToken, sha256 } from "@/lib/crypto";
import { connectDB } from "@/lib/mongodb";
import { Session } from "@/models/Session";
import { User } from "@/models/User";

export const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // seconds

export const cookieOptions = (maxAge: number) => ({
  httpOnly: true, // not readable from page JavaScript
  sameSite: "lax" as const, // not sent on cross-site POSTs, so logout can't be forged
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge,
});

/** Starts a session. The caller sets the returned token as the session cookie. */
export async function createSession(userEmail: string): Promise<string> {
  await connectDB();
  const token = randomToken();
  await Session.create({
    token_hash: sha256(token),
    user_email: userEmail,
    expires_at: new Date(Date.now() + SESSION_MAX_AGE * 1000),
  });
  return token;
}

export async function endSession(token: string | undefined): Promise<void> {
  if (!token) return;
  await connectDB();
  await Session.deleteOne({ token_hash: sha256(token) });
}

export interface CurrentUser {
  email: string;
  name: string | null;
}

/**
 * The signed-in user, or null for guests. Cached for the duration of a request,
 * so the layout and the page can both ask without two database round trips.
 * Guests (no cookie) never touch the database here.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  await connectDB();
  const session = await Session.findOne({ token_hash: sha256(token), expires_at: { $gt: new Date() } }).lean();
  if (!session) return null;

  const user = await User.findOne({ email: session.user_email }).select("email name").lean();
  return user ? { email: user.email, name: user.name ?? null } : null;
});
