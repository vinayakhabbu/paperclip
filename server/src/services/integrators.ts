import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyIntegrators } from "@paperclipai/db";
import {
  INTEGRATOR_CATALOG,
  getIntegrator,
  type CompanyIntegrator,
  type IntegratorConnectionStatus,
} from "@paperclipai/shared";

const SECRET_FIELD_RE = /token|secret|apikey|api_key|password|client_secret/i;

/** Never persist raw credentials; keep only non-secret config (URLs, ids, tenants). */
function stripSecrets(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (!SECRET_FIELD_RE.test(k)) out[k] = v;
  }
  return out;
}

export function integratorsService(db: Db) {
  function toCompanyIntegrator(
    def: (typeof INTEGRATOR_CATALOG)[number],
    row: typeof companyIntegrators.$inferSelect | undefined,
  ): CompanyIntegrator {
    return {
      key: def.key,
      label: def.label,
      system: def.system ?? def.label,
      description: def.description,
      icon: def.icon,
      accent: def.accent,
      authType: def.authType ?? "none",
      authFields: def.authFields ?? [],
      actionCount: def.actions.length,
      status: (row?.status as IntegratorConnectionStatus) ?? "available",
      config: row?.config ?? {},
      connectedAt: row?.connectedAt ? row.connectedAt.toISOString() : null,
    };
  }

  return {
    async list(companyId: string): Promise<CompanyIntegrator[]> {
      const rows = await db
        .select()
        .from(companyIntegrators)
        .where(eq(companyIntegrators.companyId, companyId));
      const byKey = new Map(rows.map((r) => [r.integratorKey, r]));
      return INTEGRATOR_CATALOG.map((def) => toCompanyIntegrator(def, byKey.get(def.key)));
    },

    async connect(companyId: string, integratorKey: string, config: Record<string, unknown>) {
      const def = getIntegrator(integratorKey);
      if (!def) return null;
      const safeConfig = stripSecrets(config);
      const existing = await db
        .select()
        .from(companyIntegrators)
        .where(and(eq(companyIntegrators.companyId, companyId), eq(companyIntegrators.integratorKey, integratorKey)))
        .then((r) => r[0] ?? null);
      const now = new Date();
      const row = existing
        ? await db
            .update(companyIntegrators)
            .set({ status: "connected", config: safeConfig, connectedAt: now, updatedAt: now })
            .where(eq(companyIntegrators.id, existing.id))
            .returning()
            .then((r) => r[0]!)
        : await db
            .insert(companyIntegrators)
            .values({ companyId, integratorKey, status: "connected", config: safeConfig, connectedAt: now })
            .returning()
            .then((r) => r[0]!);
      return toCompanyIntegrator(def, row);
    },

    async disconnect(companyId: string, integratorKey: string) {
      const def = getIntegrator(integratorKey);
      if (!def) return null;
      const now = new Date();
      const row = await db
        .update(companyIntegrators)
        .set({ status: "available", config: {}, connectedAt: null, updatedAt: now })
        .where(and(eq(companyIntegrators.companyId, companyId), eq(companyIntegrators.integratorKey, integratorKey)))
        .returning()
        .then((r) => r[0] ?? null);
      return toCompanyIntegrator(def, row ?? undefined);
    },

    /** Idempotently ensure each catalog integrator has a row (used by the auto-seed). */
    async ensureCatalogRows(companyId: string) {
      const rows = await db
        .select()
        .from(companyIntegrators)
        .where(eq(companyIntegrators.companyId, companyId));
      const present = new Set(rows.map((r) => r.integratorKey));
      let created = 0;
      for (const def of INTEGRATOR_CATALOG) {
        if (present.has(def.key)) continue;
        await db.insert(companyIntegrators).values({ companyId, integratorKey: def.key, status: "available" });
        created += 1;
      }
      return { created };
    },
  };
}
