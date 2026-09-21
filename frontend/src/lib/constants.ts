/**
 * `owner` / `user_email` value for data everyone can see (the demo inbox).
 *
 * Deliberately not an email address: real users are always identified by a
 * Gmail address (User.email is validated to contain an "@"), so nobody can
 * sign up as "shared" and inherit access to it. There is no User document
 * for it either.
 */
export const SHARED_OWNER = "shared";
