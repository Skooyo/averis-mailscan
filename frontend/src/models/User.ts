import { Schema, model, models, type InferSchemaType, type Model } from "mongoose";

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      // Must look like an address, so nobody can register as the reserved SHARED_OWNER.
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "email is not a valid address"],
    },
    api_key: String, // entered by the user; optional so people can sign in before adding one
    name: String, // from Google
    // Google sign-in. The refresh token is what lets the server read Gmail later. It is
    // stored encrypted (lib/crypto) and left out of queries unless asked for with
    // .select("+google_refresh_token"), so it can't leak into a page by accident.
    google_refresh_token: { type: String, select: false },
    google_scope: String, // space-separated scopes the user actually granted
  },
  { timestamps: true },
);

export type UserAttrs = InferSchemaType<typeof userSchema>;

export const User = (models.User as Model<UserAttrs>) || model<UserAttrs>("User", userSchema);
