import "server-only";
import { EMAIL_CATEGORIES } from "@/models/Email";

// A TypeScript port of backend/classify.py, so the site can classify emails pulled from Gmail
// without a second service. The model is called through the Vercel AI Gateway. Keep the prompt in
// sync with the Python one.

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
const BATCH_SIZE = 10; // emails per model call: the system prompt is paid once per batch, and a small batch keeps answers reliable

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

// --- Vercel AI Gateway --------------------------------------------------------
// An OpenAI-compatible Chat Completions endpoint, so one key reaches many models:
// https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions

const DEFAULT_MODEL = "alibaba/qwen3.8-omni-flash";

// Not every model behind the gateway enforces the response schema, so also spell the shape out.
// Kept out of SYSTEM_PROMPT so that stays identical to the Python pipeline's.
const FORMAT_HINT =
  '\n\nReply with only a JSON object of exactly this form, with one entry per email and no other text: {"results":[{"email_id":"...","category":"...","confidence":0.0,"reasoning":"..."}]}';
const DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh/v1";

// Structured output: every object closed, every property required. The 0-1 range of `confidence`
// is left out of the schema because not every provider behind the gateway accepts range keywords;
// parseItems() enforces it instead.
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
          confidence: { type: "number", description: "0 to 1" },
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

/** The AI Gateway API key, or (when running with one) a Vercel OIDC token. */
const gatewayToken = () => process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;

export const classifierConfigured = () => Boolean(gatewayToken());

/**
 * How much the model reasons before answering (AI_GATEWAY_REASONING): "off", an effort ("none",
 * "minimal", "low", "medium", "high"), or "default" to send nothing and use the model's own behaviour.
 *
 * Unset means "off" for the default model: measured on the 45 hand-labelled emails it was just as
 * accurate (45/45) as with reasoning, and over twice as fast (33 s vs 78 s) and cheaper. For any other
 * model nothing is sent unless asked for, since not every model accepts every reasoning setting.
 */
function reasoningParam(model: string): Record<string, unknown> {
  const value = process.env.AI_GATEWAY_REASONING?.trim().toLowerCase();
  if (value === "default") return {};
  if (!value) return model === DEFAULT_MODEL ? { reasoning: { enabled: false } } : {};
  return { reasoning: value === "off" ? { enabled: false } : { effort: value } };
}

export class ClassifierAuthError extends Error {}

const MAX_WAITS = 10; // rate-limit / transient-error retries per request
const MAX_WAIT_MS = 65_000;
export const RETRY_FALLBACK_MS = 15_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long to wait after a 429: the retry-after header, else a "try again in Ns" in the message, else 15s. */
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

/** Some providers wrap JSON in a Markdown code fence even when asked for plain JSON. */
const unfence = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

/**
 * The list of result objects inside the model's JSON answer. We ask for {"results": [...]}, but models
 * behind the gateway don't always keep to the requested shape (this one often returns a bare array),
 * so accept the reasonable variants: a bare array, one wrapper object holding an array, or a single result.
 */
function extractResults(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (Array.isArray(object.results)) return object.results;
    const arrays = Object.values(object).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0];
    if ("email_id" in object) return [object];
  }
  return null;
}

/** The valid result items in a chat-completion response, or null if it isn't the JSON we asked for. */
function parseItems(text: string): Item[] | null {
  try {
    const content = JSON.parse(text)?.choices?.[0]?.message?.content;
    const results = extractResults(JSON.parse(unfence(String(content)))) as Partial<Item>[] | null;
    if (!results) return null;
    return results
      .filter(
        (r): r is Item =>
          typeof r?.email_id === "string" &&
          typeof r?.category === "string" &&
          (EMAIL_CATEGORIES as readonly string[]).includes(r.category) &&
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
  const url = `${process.env.AI_GATEWAY_BASE_URL || DEFAULT_BASE_URL}/chat/completions`;
  const model = process.env.AI_GATEWAY_MODEL || DEFAULT_MODEL;
  const body = JSON.stringify({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT + FORMAT_HINT },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: { name: "ClassificationBatch", schema: RESPONSE_SCHEMA } },
    ...reasoningParam(model),
  });

  let waits = 0;
  let badOutput = false;
  for (;;) {
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${gatewayToken()}` },
        body,
      });
      text = await res.text();
    } catch (err) {
      if (++waits > MAX_WAITS) throw err; // network trouble: wait and retry
      await sleep(RETRY_FALLBACK_MS);
      continue;
    }

    // 401/403: bad or missing credentials. 402: the account has no credit left. None of these fix themselves.
    if (res.status === 401 || res.status === 402 || res.status === 403) {
      throw new ClassifierAuthError(`AI Gateway refused the request (${res.status}): check AI_GATEWAY_API_KEY and the account's credit`);
    }
    if (res.status === 429 || res.status >= 500) {
      if (++waits > MAX_WAITS) throw new Error(`AI Gateway kept failing (${res.status})`);
      await sleep(retryDelayMs(res, text));
      continue;
    }
    if (!res.ok) throw new Error(`AI Gateway ${res.status}: ${text.slice(0, 200)}`);

    const items = parseItems(text);
    if (items) return items;
    if (badOutput) throw new Error("The model returned unusable output twice");
    badOutput = true; // models occasionally produce malformed JSON; one retry usually fixes it
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
 * Classifies emails, 10 per model call. Emails the model skips get one individual retry.
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
