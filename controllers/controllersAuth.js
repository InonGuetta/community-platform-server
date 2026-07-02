import jwt from "jsonwebtoken";
import * as servicesAuth from "../services/servicesAuth.js";
import { badRequest } from "../lib/AppError.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  maxAge: SEVEN_DAYS_MS,
  path: "/",
});

const setAuthCookie = (res, token) => res.cookie("token", token, cookieOptions());
const clearAuthCookie = (res) => res.clearCookie("token", { ...cookieOptions(), maxAge: undefined });

export const register = async (req, res) => {
  const { email, password, displayName } = req.body;
  if (!email || !password) throw badRequest("Email and password are required");
  const { user, token } = await servicesAuth.register(email, password, displayName);
  setAuthCookie(res, token);
  res.status(201).json({ user });
};

export const login = async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) throw badRequest("Email and password are required");
  const { user, token } = await servicesAuth.login(email, password);
  setAuthCookie(res, token);
  res.status(200).json({ user });
};

export const googleCallback = (req, res) => {
  const user = req.user;
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" });
  setAuthCookie(res, token);
  const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";
  res.redirect(`${clientUrl}/auth/google/callback`);
};

export const logout = (req, res) => {
  clearAuthCookie(res);
  res.status(200).json({ message: "Logged out" });
};

export const getMe = async (req, res) => {
  const user = await servicesAuth.getMe(req.user.id);
  res.status(200).json(user);
};
