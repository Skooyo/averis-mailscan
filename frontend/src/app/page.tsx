import { InboxScreen } from "@/components/inbox-screen";
import { getCurrentUserEmail } from "@/lib/auth";
import { getInboxEmails, getLastSyncedAt } from "@/lib/emails";

// Read from MongoDB on every request rather than prerendering at build time.
export const dynamic = "force-dynamic";

export default async function Page() {
  const userEmail = await getCurrentUserEmail();
  // The two queries don't depend on each other, so run them together: this page is re-rendered
  // often while a sync is running, and each round trip to the database adds up.
  // Signed-in users get their Gmail pulled in after the page loads (see InboxScreen).
  const [emails, lastSyncedAt] = await Promise.all([
    getInboxEmails(userEmail),
    userEmail ? getLastSyncedAt(userEmail) : null,
  ]);
  return <InboxScreen emails={emails} canSync={userEmail !== null} lastSyncedAt={lastSyncedAt} />;
}
