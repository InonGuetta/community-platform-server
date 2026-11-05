// @ts-check
import { Router } from "express";
import express from "express";
import { verifyToken } from "../middleware/auth.js";
import { validateIntParam } from "../middleware/validateIntParam.js";
import * as controllersDonations from "../controllers/controllersDonations.js";

const router = Router();

router.post("/webhook", express.raw({ type: "application/json" }), controllersDonations.handleWebhook);

router.use(verifyToken);

router.post("/create-intent", controllersDonations.createIntent);
router.get("/my-history", controllersDonations.getMyHistory);
// After paying: the donor's own donation checked against Stripe (PRD PAY-1/2).
router.post("/:id/sync", validateIntParam("id"), controllersDonations.syncDonation);

export default router;
