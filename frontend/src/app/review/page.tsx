import { ReviewScreen } from "@/components/review-screen";
import { getCurrentUserEmail } from "@/lib/auth";
import { getReviewQueue } from "@/lib/results";

// Read from MongoDB on every request rather than prerendering at build time.
export const dynamic = "force-dynamic";

export default async function Page() {
  const items = await getReviewQueue(await getCurrentUserEmail());
  return <ReviewScreen items={items} />;
}
