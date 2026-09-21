import "server-only";
import mongoose from "mongoose";

// Cache the connection on `globalThis` so dev-mode hot reloads reuse one
// connection instead of opening a new one on every file change.
const cache = ((globalThis as { _mongoose?: { conn: typeof mongoose | null; promise: Promise<typeof mongoose> | null } })._mongoose ??= {
  conn: null,
  promise: null,
});

export async function connectDB() {
  if (cache.conn) return cache.conn;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not set - copy .env.example to .env and fill it in");
  }

  cache.promise ??= mongoose.connect(uri, {
    dbName: process.env.MONGODB_DB || "jobhunters",
    bufferCommands: false,
  });

  try {
    cache.conn = await cache.promise;
  } catch (err) {
    cache.promise = null; // let the next call retry
    throw err;
  }
  return cache.conn;
}
