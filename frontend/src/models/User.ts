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
    // Gmail sync bookkeeping (lib/gmail-sync).
    last_synced_at: Date, // last attempt, successful or not; the sync runs at most once per interval
    last_sync_ok_at: Date, // last attempt that succeeded: what the inbox shows as "Last synced"
    sync_started_at: Date, // set while a sync runs, so two tabs can't sync at once
    sync_error: String, // why the last attempt failed, e.g. "reauth_required"
  },
  { timestamps: true },
);

export type UserAttrs = InferSchemaType<typeof userSchema>;

export const User = (models.User as Model<UserAttrs>) || model<UserAttrs>("User", userSchema);
