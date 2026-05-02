import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
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
