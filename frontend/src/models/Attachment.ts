import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

export const DOC_TYPES = ["SI", "BL"] as const;

const attachmentSchema = new Schema(
  {
    attachment: { type: Buffer, required: true }, // the file itself (txt / pdf / xlsx / docx ...)
    doc_type: { type: String, enum: DOC_TYPES, required: true }, // which document it is
    filename: { type: String, required: true }, // e.g. "email_001_SI.txt"
    content_type: { type: String, required: true }, // MIME type, for serving the file back
    // (user_email, email_id) together point at Email (owner, id)
    email_id: { type: String, required: true }, // Email.id
    user_email: { type: String, required: true, lowercase: true, trim: true }, // User.email
  },
  { timestamps: true },
);

attachmentSchema.index({ user_email: 1, email_id: 1 });

export type AttachmentAttrs = InferSchemaType<typeof attachmentSchema>;

export const Attachment =
  (models.Attachment as Model<AttachmentAttrs>) || model<AttachmentAttrs>("Attachment", attachmentSchema);
