/**
 * Ingests inbox/*.json into the `emails` (and `attachments`) collections,
 * using data/classifications.json for category + confidence.
 *
 *   npm run ingest [-- --owner <email>] [-- --dry-run]
 *
 * `--owner` defaults to SHARED_OWNER, the demo dataset everyone can see. Pass
 * a user's email to ingest into that user's private inbox instead.
 *
 * Every email is stored in full, whatever its category: owner, id, category,
 * confidence, from, subject, body, and attachments (when it has SI/BL files).
 * Each attachment's original file (txt / pdf / xlsx / docx) is read from
 * attachments/ and stored as bytes in the `attachments` collection.
 * Selective storing per category is left for when emails come from the Gmail API.
 *
 * One rule is applied: a comparison_request must have BOTH an SI and a BL
 * attached. Otherwise it is reclassified as UNQUALIFIED_CATEGORY, and its
 * confidence is dropped (the classifier's score was for the original category).
 *
 * Re-runnable: emails are upserted on (owner, id), and each ingested email's
 * attachment docs are replaced. `--dry-run` reads the files and prints a
 * summary without connecting to MongoDB.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import mongoose, { type Types } from "mongoose";
import { SHARED_OWNER } from "../src/lib/constants";
import { Attachment, DOC_TYPES } from "../src/models/Attachment";
import { Email, EMAIL_CATEGORIES } from "../src/models/Email";
import { User } from "../src/models/User";

type Category = (typeof EMAIL_CATEGORIES)[number];
type DocType = (typeof DOC_TYPES)[number];

// Comparison requests need an SI and a BL attached to compare; without both they land here.
const UNQUALIFIED_CATEGORY: Category = "general";

// Runs from frontend/ (npm scripts always do); the inbox and data live at the repo root.
const repoRoot = path.resolve(process.cwd(), "..");

const { values: args } = parseArgs({
  options: {
    owner: { type: "string", default: SHARED_OWNER },
    "dry-run": { type: "boolean", default: false },
    inbox: { type: "string", default: path.join(repoRoot, "inbox") },
    classifications: { type: "string", default: path.join(repoRoot, "data", "classifications.json") },
  },
});

const owner = args.owner!.trim().toLowerCase();

interface InboxEmail {
  email_id: string; // "email_001"
  from: string;
  subject: string;
  body: string;
  attachments: string[]; // "attachments/email_001_SI.txt"
}

interface AttachmentFile {
  doc_type: DocType;
  filename: string;
  content_type: string;
  data: Buffer; // raw bytes of the original file
}

interface Row {
  id: string;
  category: Category;
  confidence?: number; // absent when we overrode the classifier's category
  reclassifiedFrom?: Category; // set when we overrode the classifier's category
  from: string;
  subject: string;
  body: string;
  files: AttachmentFile[]; // SI/BL attachments found on the email
}

const CONTENT_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** Attachment type comes from the _SI / _BL filename suffix; anything else is skipped. */
function docType(file: string): DocType | null {
  const m = /_(SI|BL)\.[^./\\]+$/i.exec(file);
  return m ? (m[1].toUpperCase() as DocType) : null;
}

/** Reads an inbox attachment path (relative to the repo root) into memory. */
function loadFile(emailId: string, rel: string): AttachmentFile | null {
  const doc_type = docType(rel);
  if (!doc_type) return null;

  const filename = path.basename(rel);
  let data: Buffer;
  try {
    data = readFileSync(path.join(repoRoot, rel));
  } catch {
    throw new Error(`${emailId}: attachment file not found: ${rel}`);
  }
  const content_type = CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
  return { doc_type, filename, content_type, data };
}

function loadRows(): Row[] {
  const classifications: Record<string, { category: Category; confidence: number }> = JSON.parse(
    readFileSync(args.classifications!, "utf-8"),
  );

  return readdirSync(args.inbox!)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const e: InboxEmail = JSON.parse(readFileSync(path.join(args.inbox!, f), "utf-8"));
      const c = classifications[e.email_id];
      if (!c) throw new Error(`${e.email_id} has no entry in ${args.classifications}`);
      if (!EMAIL_CATEGORIES.includes(c.category)) throw new Error(`${e.email_id}: unknown category '${c.category}'`);

      const files = (e.attachments ?? []).map((rel) => loadFile(e.email_id, rel)).filter((x) => x !== null);
      const types = files.map((x) => x.doc_type);
      const reclassified = c.category === "comparison_request" && !(types.includes("SI") && types.includes("BL"));

      return {
        id: e.email_id,
        category: reclassified ? UNQUALIFIED_CATEGORY : c.category,
        ...(reclassified ? { reclassifiedFrom: c.category } : { confidence: c.confidence }),
        from: e.from,
        subject: e.subject,
        body: e.body,
        files,
      };
    });
}

function toDoc(row: Row, attachmentIds: Types.ObjectId[] = []) {
  return {
    owner,
    id: row.id,
    category: row.category,
    ...(row.confidence !== undefined && { confidence: row.confidence }),
    from: row.from,
    subject: row.subject,
    body: row.body,
    ...(attachmentIds.length && { attachments: attachmentIds }), // absent, not [], when there are none
  };
}

function summarise(rows: Row[]) {
  const counts = Object.fromEntries(EMAIL_CATEGORIES.map((c) => [c, rows.filter((r) => r.category === c).length]));
  console.log(`owner: ${owner}`);
  console.log(`emails: ${rows.length}`, counts);
  const files = rows.flatMap((r) => r.files);
  const byExt = Object.entries(Object.groupBy(files, (x) => path.extname(x.filename).toLowerCase()))
    .map(([ext, v]) => `${ext}: ${v!.length}`)
    .join(", ");
  console.log(`  with attachments: ${rows.filter((r) => r.files.length).length}`);
  console.log(`  attachments to create: ${files.length} (${byExt}), ${(files.reduce((n, x) => n + x.data.length, 0) / 1e6).toFixed(2)} MB`);

  const reclassified = rows.filter((r) => r.reclassifiedFrom);
  if (reclassified.length) {
    const had = (r: Row) => (r.files.length ? `${r.files.map((x) => x.doc_type).join("+")} only` : "no SI/BL");
    const tally = Object.entries(Object.groupBy(reclassified, had)).map(([k, v]) => `${k}: ${v!.length}`);
    console.log(
      `  comparison_request reclassified to '${UNQUALIFIED_CATEGORY}' (needs both SI and BL): ${reclassified.length} (${tally.join(", ")})`,
    );
    console.log(`    ${reclassified.map((r) => r.id).join(", ")}`);
  }
}

async function main() {
  const rows = loadRows();
  summarise(rows);

  if (args["dry-run"]) {
    console.log("\n--dry-run, nothing written. Example records:");
    for (const r of [
      rows.find((r) => r.files.length && !r.reclassifiedFrom),
      rows.find((r) => r.reclassifiedFrom),
      rows.find((r) => r.category === "spam"),
    ]) {
      if (r) console.log({ ...toDoc(r), body: r.body.slice(0, 60) + "..." });
    }
    return;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set - copy .env.example to .env and fill it in");
  await mongoose.connect(uri, { dbName: process.env.MONGODB_DB || "jobhunters" });

  // The shared owner has no User document; personal owners must exist.
  if (owner !== SHARED_OWNER && !(await User.exists({ email: owner }))) {
    throw new Error(`no user '${owner}' in the users collection - create it first (e.g. via npm run seed)`);
  }

  // Replace attachments first so emails can reference their new _ids.
  await Attachment.deleteMany({ user_email: owner, email_id: { $in: rows.map((r) => r.id) } });
  const created = await Attachment.insertMany(
    rows.flatMap((r) =>
      r.files.map(({ data, ...meta }) => ({ ...meta, attachment: data, email_id: r.id, user_email: owner })),
    ),
  );
  const idsByEmail = new Map<string, Types.ObjectId[]>();
  for (const a of created) idsByEmail.set(a.email_id, [...(idsByEmail.get(a.email_id) ?? []), a._id]);

  // replaceOne (not update) so fields from an earlier ingest that no longer apply are dropped.
  const result = await Email.bulkWrite(
    rows.map((r) => ({
      replaceOne: {
        filter: { owner, id: r.id },
        replacement: toDoc(r, idsByEmail.get(r.id)),
        upsert: true,
      },
    })) as Parameters<typeof Email.bulkWrite>[0],
    { ordered: false },
  );

  console.log(
    `\ningested: ${result.upsertedCount} emails inserted, ${result.modifiedCount} replaced, ${created.length} attachments`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
