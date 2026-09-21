import { InboxScreen } from "@/components/inbox-screen";
import { getCurrentUserEmail } from "@/lib/auth";
import { getInboxEmails } from "@/lib/emails";

// Read from MongoDB on every request rather than prerendering at build time.
export const dynamic = "force-dynamic";

export default async function Page() {
  const emails = await getInboxEmails(await getCurrentUserEmail());
  return <InboxScreen emails={emails} />;
}
