import { getCurrentUserEmail } from "@/lib/auth";
import { getAttachmentFile } from "@/lib/emails";

// Only these two content types (never arbitrary attacker-influenced ones -- content type comes
// from a fixed extension map, never the original filename) may render inline, for the SI/BL
// preview panes on the comparison page. A browser renders plain text as text and a PDF in its own
// sandboxed viewer; neither executes as a page in our origin, unlike e.g. text/html would.
const INLINE_TYPES = new Set(["text/plain", "application/pdf"]);

export async function GET(req: Request, { params }: { params: Promise<{ attachmentId: string }> }) {
  const { attachmentId } = await params;
  const file = await getAttachmentFile(attachmentId, await getCurrentUserEmail());
  if (!file) return new Response("Not found", { status: 404 });

  const inline = new URL(req.url).searchParams.get("view") === "1" && INLINE_TYPES.has(file.contentType);

  // Plain-ASCII fallback plus the RFC 5987 form for anything else.
  const fallback = file.filename.replace(/[^\w.-]/g, "_");
  return new Response(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "X-Content-Type-Options": "nosniff", // never let the browser guess a type and render it
      "Cache-Control": "private, no-store", // per-user data
    },
  });
}
