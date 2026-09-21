import "server-only";
import { EMAIL_CATEGORIES } from "@/models/Email";

// A TypeScript port of backend/classify.py + backend/llm.py, so the site can classify emails
// pulled from Gmail without a second service. Keep the prompt in sync with the Python one.

export type Category = (typeof EMAIL_CATEGORIES)[number];

export interface Classification {
  category: Category;
  confidence: number; // 0-1
  reasoning: string;
}

export interface ClassifyInput {
  id: string;
  from: string;
  subject: string;
  body: string;
  /** SI / BL attachments found on the email (by filename). */
  attachments: { docType: "SI" | "BL" }[];
}

const BODY_LIMIT = 1200;
const BATCH_SIZE = 10; // per call: Groq's free tier is token-limited, so the prompt is paid once per batch

export const SYSTEM_PROMPT = `You classify emails in a shipping-documentation team's inbox. Decide by what the sender is ASKING FOR in the BODY. Subject lines in this inbox are unreliable thread titles — never let them override the body. Missing, dropped or broken attachments do NOT change the category.

Categories:
1. comparison_request — asks us to check / compare / verify a Shipping Instruction (SI) against a draft Bill of Lading (BL) and confirm. E.g. "Attached are the SI and draft BL ... please check and confirm", "Kindly verify the BL matches the SI", "check the draft BL against the SI ... revert with any discrepancy", "Please compare the SI and draft BL". Still this category if the BL is missing, attachments were dropped, a file won't open, copies are scanned, SI fields are blank, or the second attachment is a packing list / invoice / certificate instead of the BL.
2. new_si_request — sender supplies shipment details so a Shipping Instruction can be prepared, or asks for an SI to be raised. E.g. "Please find Shipping instruction for <ref>" followed by inline POL / POD / Shipper / Consignee / Notify blocks — even if it closes with "revert with draft BL once available".
3. invoice_query — money owed or billed: invoice questions, THC / local charge breakdowns, D&D / detention charges to confirm, missing GR blocking billing, cancel invoice / reverse PGI, freight totals.
4. general — other legitimate work email: "please send the draft BL for checking" (asks us to SEND a document, not compare two), outstanding BL lists, reminders to submit SI & AED, berthing reports, loading update summaries, automated RPA notices ("billing process completed, no action required"), greetings, office notices.
5. spam — marketing, prizes, phishing, account verification scams, crypto / investment offers, fake parcel fees, "bank officer" proposals.

Output one result per email, keeping each email_id exactly as given. confidence 0.9+ when a typical phrase matches; below 0.6 only when two categories are genuinely plausible. reasoning: one short sentence quoting the decisive phrase.`;

// --- prompt rendering (same as the Python side) -----------------------------

const BANNER_RE = /^WARNING: This email originated outside[\s\S]*?\n\n/; // [\s\S] not /s: the TS target predates that flag
const SIGNOFF_RE = /\n\s*(Best Regards|Best regards|Kind regards|Regards|Thank you,|Thanks,|Warm regards|Best,|-- RPA Bot)\b[\s\S]*/;

/** Drops the external-sender banner and the signature block, and caps the length. */
export function cleanBody(body: string): string {
  let out = body.replace(/\r\n/g, "\n").replace(BANNER_RE, "").replace(SIGNOFF_RE, "").trim();
  if (out.length > BODY_LIMIT) out = out.slice(0, BODY_LIMIT) + "\n[...truncated]";
  return out;
}

export function renderEmail(e: ClassifyInput): string {
  const si = e.attachments.some((a) => a.docType === "SI");
  const bl = e.attachments.some((a) => a.docType === "BL");
  return (
    `email_id: ${e.id}\n` +
    `From: ${e.from}\n` +
    `Subject: ${e.subject}\n` +
    `Attachments: ${e.attachments.length} (SI: ${si ? "yes" : "no"}, BL: ${bl ? "yes" : "no"}, unreadable: 0)\n` +
    `Body:\n${cleanBody(e.body)}`
  );
}

export function renderBatch(emails: ClassifyInput[]): string {
  const parts = [`Classify these ${emails.length} emails.\n`];
  emails.forEach((e, i) => parts.push(`=== EMAIL ${i + 1} ===\n${renderEmail(e)}`));
  return parts.join("\n\n");
}

// --- Groq -----------------------------------------------------------------------

// Groq strict structured output: every object closed, every property required.
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          email_id: { type: "string" },
          category: { type: "string", enum: [...EMAIL_CATEGORIES] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          reasoning: { type: "string" },
        },
        required: ["email_id", "category", "confidence", "reasoning"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

export const classifierConfigured = () => Boolean(process.env.GROQ_API_KEY);

export class ClassifierAuthError extends Error {}

const MAX_WAITS = 10; // rate-limit / transient-error retries per request
const MAX_WAIT_MS = 65_000;
export const RETRY_FALLBACK_MS = 15_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long to wait after a 429: Groq's retry-after header, else the "try again in Ns" text, else 15s. */
function retryDelayMs(res: Response | null, text: string): number {
  const header = Number(res?.headers.get("retry-after"));
  if (res?.headers.get("retry-after") && Number.isFinite(header)) return Math.min((header + 1) * 1000, MAX_WAIT_MS);
  const m = /try again in ([\d.]+)s/.exec(text);
  return m ? Math.min((Number(m[1]) + 1) * 1000, MAX_WAIT_MS) : RETRY_FALLBACK_MS;
}

interface Item {
  email_id: string;
  category: Category;
  confidence: number;
  reasoning: string;
}

/** The valid result items in a chat-completion response, or null if it isn't the JSON we asked for. */
function parseItems(text: string): Item[] | null {
  try {
    const content = JSON.parse(text)?.choices?.[0]?.message?.content;
    const results = JSON.parse(content)?.results;
    if (!Array.isArray(results)) return null;
    return results
      .filter(
        (r): r is Item =>
          typeof r?.email_id === "string" &&
          (EMAIL_CATEGORIES as readonly string[]).includes(r?.category) &&
          typeof r?.confidence === "number" &&
          r.confidence >= 0 &&
          r.confidence <= 1,
      )
      .map((r) => ({ email_id: r.email_id, category: r.category, confidence: r.confidence, reasoning: String(r.reasoning ?? "") }));
  } catch {
    return null;
  }
}

async function complete(user: string): Promise<Item[]> {
  const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
  const url = `${process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1"}/chat/completions`;
  const body = JSON.stringify({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: { name: "ClassificationBatch", strict: true, schema: RESPONSE_SCHEMA } },
    // reasoning tokens count against the free-tier token limits
    ...(model.includes("gpt-oss") && { reasoning_effort: "low" }),
  });

  let waits = 0;
  let badOutput = false;
  for (;;) {
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        body,
      });
      text = await res.text();
    } catch (err) {
      if (++waits > MAX_WAITS) throw err; // network trouble: wait and retry
      await sleep(RETRY_FALLBACK_MS);
      continue;
    }

    if (res.status === 401 || res.status === 403) throw new ClassifierAuthError(`Groq rejected the API key (${res.status})`);
    if (res.status === 429 || res.status >= 500) {
      if (++waits > MAX_WAITS) throw new Error(`Groq kept failing (${res.status})`);
      await sleep(retryDelayMs(res, text));
      continue;
    }
    if (!res.ok) {
      // The model occasionally produces output Groq itself rejects; one retry usually fixes it.
      if (res.status === 400 && text.includes("json_validate_failed") && !badOutput) {
        badOutput = true;
        continue;
      }
      throw new Error(`Groq ${res.status}: ${text.slice(0, 200)}`);
    }

    const items = parseItems(text);
    if (items) return items;
    if (badOutput) throw new Error("Groq returned unusable output twice");
    badOutput = true;
  }
}

function pick(items: Item[], wanted: ClassifyInput[]): Map<string, Classification> {
  const ids = new Set(wanted.map((e) => e.id));
  const out = new Map<string, Classification>();
  for (const it of items) {
    if (ids.has(it.email_id) && !out.has(it.email_id)) {
      out.set(it.email_id, { category: it.category, confidence: it.confidence, reasoning: it.reasoning });
    }
  }
  return out;
}

/**
 * Classifies emails, 10 per Groq call. Emails the model skips get one individual retry.
 *
 * `onBatch` is called as each batch finishes, with its results and the ids that got none, so
 * the caller can show progress instead of waiting for everything. A batch that fails outright
 * just reports all its ids as failed (the caller decides whether to retry later); only a
 * rejected API key aborts everything.
 */
export async function classifyEmails(
  inputs: ClassifyInput[],
  onBatch?: (results: Map<string, Classification>, failedIds: string[]) => Promise<void>,
): Promise<Map<string, Classification>> {
  const out = new Map<string, Classification>();

  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    const batch = inputs.slice(i, i + BATCH_SIZE);
    let got = new Map<string, Classification>();
    try {
      got = pick(await complete(renderBatch(batch)), batch);
      for (const e of batch) {
        if (got.has(e.id)) continue;
        const single = pick(await complete(renderBatch([e])), [e]);
        single.forEach((v, k) => got.set(k, v));
      }
    } catch (err) {
      if (err instanceof ClassifierAuthError) throw err;
      console.error(`Classifying a batch of ${batch.length} emails failed; they will be retried next sync:`, err);
      // keep whatever this batch did classify before the failure
    }
    got.forEach((v, k) => out.set(k, v));
    await onBatch?.(got, batch.map((e) => e.id).filter((id) => !got.has(id)));
  }
  return out;
}
