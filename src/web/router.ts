import express, { Router } from "express";
import type { Services } from "../services.js";
import { accountRoutes } from "./account.js";
import { adminRoutes } from "./admin.js";
import { buyRoutes } from "./buy.js";
import { sessionMiddleware } from "./session.js";
import { signupRoutes } from "./signup.js";

/** The account, checkout and admin pages. The marketing site lives elsewhere (site/). */
export function webRouter(services: Services): Router {
  const router = Router();
  router.use(express.urlencoded({ extended: false, limit: "32kb" }));
  router.use(sessionMiddleware(services));
  router.use(signupRoutes(services));
  router.use(accountRoutes(services));
  router.use(buyRoutes(services));
  router.use("/admin", adminRoutes(services));
  return router;
}
