import { getCurrentUserEmail } from "@/lib/auth";
import { getAttachmentFile } from "@/lib/emails";

export async function GET(_req: Request, { params }: { params: Promise<{ attachmentId: string }> }) {
  const { attachmentId } = await params;
  const file = await getAttachmentFile(attachmentId, await getCurrentUserEmail());
  if (!file) return new Response("Not found", { status: 404 });

  // Plain-ASCII fallback plus the RFC 5987 form for anything else.
  const fallback = file.filename.replace(/[^\w.-]/g, "_");
  return new Response(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "X-Content-Type-Options": "nosniff", // never let the browser guess a type and render it
      "Cache-Control": "private, no-store", // per-user data
    },
  });
}
