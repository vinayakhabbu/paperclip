import { asc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { agentsStudioService } from "./agents-studio.js";
import { integratorsService } from "./integrators.js";

function isEnabled(): boolean {
  const v = process.env.PAPERCLIP_AUTOSEED_AI_FACTORY;
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Option A auto-provisioning: when PAPERCLIP_AUTOSEED_AI_FACTORY is set, ensure
 * the primary company has the AI Factory org + integrator rows on every boot.
 * Idempotent — only fills in what's missing. Runs best-effort; never blocks or
 * crashes startup.
 */
export async function autoSeedAiFactory(db: Db): Promise<void> {
  if (!isEnabled()) return;
  try {
    const primary = await db
      .select()
      .from(companies)
      .orderBy(asc(companies.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!primary) {
      logger.info("AI Factory auto-seed: no company yet; skipping");
      return;
    }
    const org = await agentsStudioService(db).provisionOrg(primary.id);
    const integ = await integratorsService(db).ensureCatalogRows(primary.id);
    logger.info(
      { companyId: primary.id, agentsCreated: org.createdCount, integratorsCreated: integ.created },
      "AI Factory auto-seed complete",
    );
  } catch (err) {
    logger.warn({ err }, "AI Factory auto-seed failed (non-fatal)");
  }
}
