import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Per-company connection state for an Integrator (an external enterprise system
 * the AI factory stitches into workflows). The integrator catalog itself is
 * static code; this table only tracks which integrators a company has connected
 * and their (non-secret) config. Secret material lives in company_secrets.
 */
export const companyIntegrators = pgTable(
  "company_integrators",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    integratorKey: text("integrator_key").notNull(),
    status: text("status").notNull().default("available"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUq: uniqueIndex("company_integrators_company_key_uq").on(table.companyId, table.integratorKey),
    companyStatusIdx: index("company_integrators_company_status_idx").on(table.companyId, table.status),
  }),
);
