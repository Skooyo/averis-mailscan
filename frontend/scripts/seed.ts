/**
 * Loads example users / emails / attachments so there's something to look at
 * in Compass. Run with `npm run seed` (needs MONGODB_URI in .env / .env.local).
 *
 * Re-runnable: it first deletes anything belonging to the example users below
 * (@example.com) and inserts fresh copies. Other data is left alone.
 */
import mongoose from "mongoose";
import { Attachment } from "../src/models/Attachment";
import { Email } from "../src/models/Email";
import { User } from "../src/models/User";

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("MONGODB_URI is not set - copy .env.example to .env and fill it in");

const users = [
  { email: "alice@example.com", api_key: "gsk_example_alice_0000000000000000" },
  { email: "bob@example.com", api_key: "gsk_example_bob_000000000000000000" },
];

type SeedEmail = {
  owner: string;
  id: number;
  category: "comparison_request" | "new_si_request" | "invoice_query" | "general" | "spam";
  from: string;
  subject: string;
  body?: string; // only SI/BL emails
  docs?: ("SI" | "BL")[]; // attachments to create for this email
};

// Modelled on the real inbox (inbox/email_001.json etc.)
const emails: SeedEmail[] = [
  {
    owner: "alice@example.com",
    id: 1,
    category: "comparison_request",
    from: "aziztz@safqa.co.ke",
    subject: "TO CONFIRM DOCS _ 5RSG-00133 _ CALLAO_PERU _ MOORIM SP CO., LTD _ MEDUUD104332",
    body: "Hi Najiha,\n\nAttached are the SI and draft BL for OC 5RSG-00133 (PAPERONE DIGITAL COPIER PAPER). Please check the details and confirm.",
    docs: ["SI", "BL"],
  },
  {
    owner: "alice@example.com",
    id: 2,
    category: "new_si_request",
    from: "ops@paperone.example",
    subject: "SI for OC 5RSG-00201 _ PORT KLANG to ROTTERDAM",
    body: "Please find Shipping Instruction for OC 5RSG-00201.\nPOL: PORT KLANG (MYPKG)\nPOD: ROTTERDAM (NLRTM)\nShipper: APRIL FAR EAST (M) SDN BHD\nConsignee: EXAMPLE TRADING BV\n\nRevert with draft BL once available.",
    docs: ["SI"],
  },
  {
    owner: "alice@example.com",
    id: 3,
    category: "invoice_query",
    from: "billing@carrier.example",
    subject: "Query on invoice INV-88231",
    // no body/attachments: only stored for SI/BL emails
  },
  {
    owner: "alice@example.com",
    id: 4,
    category: "general",
    from: "noreply@rpa.example",
    subject: "Billing process completed - no action required",
  },
  {
    owner: "alice@example.com",
    id: 5,
    category: "spam",
    from: "support@prize-claims.info",
    subject: "You have won! Claim your reward now",
  },
  {
    owner: "bob@example.com",
    id: 1, // ids are per owner, so this doesn't clash with alice's id 1
    category: "comparison_request",
    from: "docs@shipper.example",
    subject: "Draft BL check - MEDUUD104999",
    body: "Hi Bob,\n\nSI and draft BL attached, please compare and let us know if anything doesn't match.",
    docs: ["SI", "BL"],
  },
  {
    owner: "bob@example.com",
    id: 2,
    category: "general",
    from: "customer@example.org",
    subject: "Please send the draft BL for OC 5RSG-00310 for checking",
  },
];

async function main() {
  await mongoose.connect(uri!, { dbName: process.env.MONGODB_DB || "jobhunters" });

  const userEmails = users.map((u) => u.email);
  await Attachment.deleteMany({ user_email: { $in: userEmails } });
  await Email.deleteMany({ owner: { $in: userEmails } });
  await User.deleteMany({ email: { $in: userEmails } });

  await User.insertMany(users);

  for (const { docs = [], ...email } of emails) {
    // Attachments first so the email can hold their _ids.
    const attachments = await Attachment.insertMany(
      docs.map((doc) => ({ doc, email_id: email.id, user_email: email.owner })),
    );
    await Email.create({
      ...email,
      ...(attachments.length && { attachments: attachments.map((a) => a._id) }),
    });
  }

  const [u, e, a] = await Promise.all([User.countDocuments(), Email.countDocuments(), Attachment.countDocuments()]);
  console.log(`seeded '${mongoose.connection.name}': users=${u} emails=${e} attachments=${a}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
