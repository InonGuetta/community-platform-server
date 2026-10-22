// @ts-check
import passport from "passport";
// Default import, not `{ Strategy as GoogleStrategy }`. The package is CommonJS
// and does `module.exports = Strategy` (it also hangs a `.Strategy` off it, which
// is why the named form happened to work at runtime) — so under NodeNext the
// default IS the constructor, and the named import is the one TypeScript
// refuses. Same object either way.
import GoogleStrategy from "passport-google-oauth20";
import { googleOAuthLogin } from "../services/servicesAuth.js";
import { AppError } from "../lib/AppError.js";
import { env } from "../lib/env.js";
import { logger } from "../lib/logger.js";

passport.use(
  new GoogleStrategy(
    {
      clientID: env.googleClientId,
      clientSecret: env.googleClientSecret,
      callbackURL: "/api/auth/google/callback",
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const user = await googleOAuthLogin(profile);
        done(null, user);
      } catch (err) {
        // A refusal (deactivated account, unverified address, no email) is an
        // answer for the USER, who is mid-redirect from Google in a browser.
        // `done(null, false)` sends them to failureRedirect — the sign-in page —
        // instead of handing an AppError to errorHandler, which would leave them
        // looking at a raw JSON body. Only genuine faults go to the handler.
        if (err instanceof AppError) {
          logger.info(`[auth] Google sign-in refused: ${err.message}`);
          return done(null, false);
        }
        done(err, null);
      }
    }
  )
);

export default passport;
