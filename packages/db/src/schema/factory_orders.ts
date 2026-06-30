import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * An AI SDLC Factory order: a request to produce a new agent + workflow that
 * moves through lifecycle stages (intake → design → build → test → deploy →
 * live). The produced agent/workflow are linked once they exist.
 */
export const factoryOrders = pgTable(
  "factory_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    domain: text("domain").notNull().default("general"),
    stage: text("stage").notNull().default("intake"),
    description: text("description"),
    producedWorkflowId: uuid("produced_workflow_id"),
    producedAgentId: uuid("produced_agent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStageIdx: index("factory_orders_company_stage_idx").on(table.companyId, table.stage),
  }),
);
