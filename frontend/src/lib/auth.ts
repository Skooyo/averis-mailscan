import "server-only";

/**
 * The signed-in user's email, or null when nobody is signed in.
 *
 * There's no auth yet, so everyone is anonymous and only sees the shared
 * dataset. When OAuth lands, return the email from the verified session here;
 * the pages already pass this through to the queries.
 */
export async function getCurrentUserEmail(): Promise<string | null> {
  return null;
}
