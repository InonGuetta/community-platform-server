// @ts-check
import passport from "passport";
// Default import, not `{ Strategy as GoogleStrategy }`. The package is CommonJS
// and does `module.exports = Strategy` (it also hangs a `.Strategy` off it, which
// is why the named form happened to work at runtime) — so under NodeNext the
// default IS the constructor, and the named import is the one TypeScript
// refuses. Same object either way.
import GoogleStrategy from "passport-google-oauth20";
import { googleOAuthLogin } from "../services/servicesAuth.js";

// TODO(CR): two issues.
//  1. GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are read from process.env directly
//     rather than through lib/env.js, against the project rule — a missing value
//     is not caught at boot, it surfaces as a broken OAuth redirect.
//  2. googleOAuthLogin throws AppError(401) for a deactivated account or an
//     unverified email. `done(err)` sends that to errorHandler, so the user's
//     browser — mid-redirect from Google — lands on a raw JSON body instead of
//     the sign-in page. Pass `done(null, false, { message })` for AppErrors so
//     failureRedirect applies, and reserve `done(err)` for real failures.
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "/api/auth/google/callback",
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const user = await googleOAuthLogin(profile);
        done(null, user);
      } catch (err) {
        done(err, null);
      }
    }
  )
);

export default passport;
