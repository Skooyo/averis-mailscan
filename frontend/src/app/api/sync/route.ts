import { getCurrentUser } from "@/lib/auth";
import { syncGmail } from "@/lib/gmail-sync";

// The first sync fetches and classifies up to 50 emails, which can take a minute or two
// (Groq's free tier rate-limits). Matters on serverless hosts; a normal server ignores it.
export const maxDuration = 300;

/**
 * Pulls new mail from the signed-in user's Gmail. The inbox page calls this after it loads, and
 * again (with `force`) when the refresh button is clicked. POST + a SameSite=Lax session cookie,
 * so another website can't trigger a sync.
 *
 * With `stream: true` the response is newline-delimited JSON: a `{"type":"progress"}` line each time
 * the inbox has changed (new emails stored, a batch classified), so the page can refresh at once
 * instead of polling, then a final `{"type":"result","result":{...}}` line. Without it, plain JSON.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ status: "error", error: "signed_out" }, { status: 401 });

  // The refresh button sends force: true to check Gmail now instead of waiting out the throttle.
  const body = await req.json().catch(() => null);
  const force = body?.force === true;
  if (body?.stream !== true) return Response.json(await syncGmail(user.email, { force }));

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (line: object) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
        } catch {
          // the browser went away; the sync carries on regardless
        }
      };
      try {
        const result = await syncGmail(user.email, { force, onProgress: () => send({ type: "progress" }) });
        send({ type: "result", result });
      } catch (err) {
        console.error("Gmail sync crashed:", err);
        send({ type: "result", result: { status: "error", error: "failed" } });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
