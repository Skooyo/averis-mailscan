import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

// Same categories the Python classifier emits (backend/models.py `Category`).
export const EMAIL_CATEGORIES = [
  "comparison_request",
  "new_si_request",
  "invoice_query",
  "general",
  "spam",
] as const;

const emailSchema = new Schema(
  {
    owner: { type: String, required: true, lowercase: true, trim: true }, // User.email
    id: { type: String, required: true }, // unique per owner, not globally (e.g. "email_001" or a Gmail message id)
    // Missing only while the email is still being classified (status "processing").
    category: {
      type: String,
      enum: EMAIL_CATEGORIES,
      required: function (this: { status?: string | null }) {
        return this.status !== "processing";
      },
    },
    // "processing" from the moment a Gmail sync stores the email until classification finishes;
    // absent on every finished email. See lib/gmail-sync.
    status: { type: String, enum: ["processing"] },
    // Only set for SI/BL emails. `default: undefined` keeps the field absent
    // instead of Mongoose's default empty array.
    attachments: {
      type: [{ type: Schema.Types.ObjectId, ref: "Attachment" }],
      default: undefined,
    },
    body: String, // only set for SI/BL emails
    from: String,
    subject: String,
    confidence: Number, // classification confidence score
    sent_at: Date, // when the email was sent (Gmail Date header); not in the demo dataset
  },
  // `id: false` stops Mongoose adding its own `id` virtual over our `id` field.
  { id: false, timestamps: true },
);

emailSchema.index({ owner: 1, id: 1 }, { unique: true });

export type EmailAttrs = InferSchemaType<typeof emailSchema>;

export const Email = (models.Email as Model<EmailAttrs>) || model<EmailAttrs>("Email", emailSchema);
