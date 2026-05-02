import jwt from "jsonwebtoken";
import * as servicesAuth from "../services/servicesAuth.js";

export const register = async (req, res) => {
  try {
    const { email, password, displayName } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password are required" });
    const result = await servicesAuth.register(email, password, displayName);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

export const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: "Email and password are required" });
    const result = await servicesAuth.login(email, password);
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

export const googleCallback = (req, res) => {
  const user = req.user;
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" });
  const clientUrl = process.env.CLIENT_URL || "http://localhost:5173";
  res.redirect(`${clientUrl}/auth/google/callback?token=${token}`);
};

export const logout = (req, res) => {
  res.status(200).json({ message: "Logged out" });
};

export const getMe = async (req, res) => {
  try {
    const user = await servicesAuth.getMe(req.user.id);
    res.status(200).json(user);
  } catch (err) {
    res.status(404).json({ message: err.message });
  }
};
