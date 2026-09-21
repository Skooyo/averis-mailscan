import { notFound } from "next/navigation";
import { ComparisonScreen } from "@/components/comparison-screen";
import { getCurrentUserEmail } from "@/lib/auth";
import { getEmailByBusinessId } from "@/lib/emails";
import { getComparisonResult } from "@/lib/results";

// Read from MongoDB on every request rather than prerendering at build time.
export const dynamic = "force-dynamic";

// `emailId` is the email's own business id (e.g. "email_001"), not the emails collection _id --
// this is how the rest of the app already links here (components/inbox-screen.tsx,
// app/emails/[emailId]/page.tsx both use `email.id`).
export default async function Page({ params }: { params: Promise<{ emailId: string }> }) {
  const { emailId } = await params;
  const userEmail = await getCurrentUserEmail();

  // A Result doc may not exist yet even though the Email does (the pipeline runs out-of-band, see
  // HANDOVER.md, and may not have processed every email in every environment) -- and, in the
  // other direction, a Result can exist for an email_id whose Email doc isn't visible to this
  // viewer (or was never ingested at all). Only 404 when NEITHER is visible; ComparisonScreen
  // already handles `result: null` and a null `subject` gracefully.
  const [email, result] = await Promise.all([
    getEmailByBusinessId(emailId, userEmail),
    getComparisonResult(emailId, userEmail),
  ]);
  if (!email && !result) notFound();

  return <ComparisonScreen emailId={emailId} subject={email?.subject ?? null} result={result} />;
}
