import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

const sessionSchema = new Schema(
  {
    // SHA-256 of the token in the browser's cookie. The token itself is never stored,
    // so a leaked database can't be used to sign in.
    token_hash: { type: String, required: true, unique: true },
    user_email: { type: String, required: true, lowercase: true, trim: true }, // User.email
    expires_at: { type: Date, required: true },
  },
  { timestamps: true },
);

// MongoDB deletes the document once expires_at has passed.
sessionSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

export type SessionAttrs = InferSchemaType<typeof sessionSchema>;

export const Session = (models.Session as Model<SessionAttrs>) || model<SessionAttrs>("Session", sessionSchema);
