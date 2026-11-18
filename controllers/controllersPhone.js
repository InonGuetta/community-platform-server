// @ts-check
// The signed-in user's own mobile number (services/servicesPhone.js, PRD
// AUTH-13). Mounted by routes/routersAuth.js, beside the rest of one's own
// account. Every answer is the account's phone state, which the client merges
// into its user.
import * as servicesPhone from "../services/servicesPhone.js";
import { requirePhone, phoneCodeOf } from "../lib/validate.js";

// Send a code to the number typed. 200 with the number now waiting for it.
export const startVerification = async (req, res) => {
  const e164 = requirePhone(req.body?.phone);
  res.status(200).json(await servicesPhone.startPhoneVerification(req.user.id, e164));
};

export const verifyCode = async (req, res) => {
  const { state } = await servicesPhone.verifyPhoneCode(req.user.id, phoneCodeOf(req.body?.code));
  res.status(200).json(state);
};

export const removePhone = async (req, res) => {
  res.status(200).json(await servicesPhone.removePhone(req.user.id));
};
