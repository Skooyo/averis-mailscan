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
    api_key: { type: String, required: true }, // entered by the user
  },
  { timestamps: true },
);

export type UserAttrs = InferSchemaType<typeof userSchema>;

export const User = (models.User as Model<UserAttrs>) || model<UserAttrs>("User", userSchema);
