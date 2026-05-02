import { Router } from "express";
import express from "express";
import { verifyToken } from "../middleware/auth.js";
import * as controllersDonations from "../controllers/controllersDonations.js";

const router = Router();

router.post("/webhook", express.raw({ type: "application/json" }), controllersDonations.handleWebhook);

router.use(verifyToken);

router.post("/create-intent", controllersDonations.createIntent);
router.get("/my-history", controllersDonations.getMyHistory);

export default router;
