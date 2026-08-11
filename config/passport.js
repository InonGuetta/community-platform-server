// @ts-check
import passport from "passport";
// Default import, not `{ Strategy as GoogleStrategy }`. The package is CommonJS
// and does `module.exports = Strategy` (it also hangs a `.Strategy` off it, which
// is why the named form happened to work at runtime) — so under NodeNext the
// default IS the constructor, and the named import is the one TypeScript
// refuses. Same object either way.
import GoogleStrategy from "passport-google-oauth20";
import { googleOAuthLogin } from "../services/servicesAuth.js";

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
