import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

export const DOC_TYPES = ["SI", "BL"] as const;

const attachmentSchema = new Schema(
  {
    doc: { type: String, enum: DOC_TYPES, required: true },
    // (user_email, email_id) together point at Email (owner, id)
    email_id: { type: Number, required: true }, // Email.id
    user_email: { type: String, required: true, lowercase: true, trim: true }, // User.email
  },
  { timestamps: true },
);

attachmentSchema.index({ user_email: 1, email_id: 1 });

export type AttachmentAttrs = InferSchemaType<typeof attachmentSchema>;

export const Attachment =
  (models.Attachment as Model<AttachmentAttrs>) || model<AttachmentAttrs>("Attachment", attachmentSchema);
