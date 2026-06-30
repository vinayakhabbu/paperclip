import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { factoryOrders } from "@paperclipai/db";
import { nextFactoryStage, type FactoryOrderCreateInput, type FactoryStage } from "@paperclipai/shared";

export function factoryOrdersService(db: Db) {
  return {
    list: (companyId: string) =>
      db
        .select()
        .from(factoryOrders)
        .where(eq(factoryOrders.companyId, companyId))
        .orderBy(desc(factoryOrders.createdAt)),

    create: (companyId: string, input: FactoryOrderCreateInput) =>
      db
        .insert(factoryOrders)
        .values({
          companyId,
          title: input.title,
          domain: input.domain,
          description: input.description ?? null,
          stage: "intake",
        })
        .returning()
        .then((rows) => rows[0]!),

    /** Promote an order to the next lifecycle stage, optionally linking outputs. */
    async advance(
      companyId: string,
      id: string,
      links: { producedWorkflowId?: string | null; producedAgentId?: string | null },
    ) {
      const order = await db
        .select()
        .from(factoryOrders)
        .where(and(eq(factoryOrders.companyId, companyId), eq(factoryOrders.id, id)))
        .then((rows) => rows[0] ?? null);
      if (!order) return null;
      const next = nextFactoryStage(order.stage as FactoryStage);
      const patch: Partial<typeof factoryOrders.$inferInsert> = { updatedAt: new Date() };
      if (next) patch.stage = next;
      if (links.producedWorkflowId !== undefined) patch.producedWorkflowId = links.producedWorkflowId;
      if (links.producedAgentId !== undefined) patch.producedAgentId = links.producedAgentId;
      return db
        .update(factoryOrders)
        .set(patch)
        .where(eq(factoryOrders.id, id))
        .returning()
        .then((rows) => rows[0]!);
    },

    remove: (companyId: string, id: string) =>
      db
        .delete(factoryOrders)
        .where(and(eq(factoryOrders.companyId, companyId), eq(factoryOrders.id, id)))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
