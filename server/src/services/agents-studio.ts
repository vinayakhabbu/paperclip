import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWorkflowRuns, agentWorkflows, agents } from "@paperclipai/db";
import {
  AI_FACTORY_ORG_TEMPLATE,
  getConnectorAction,
  getWorkflowTemplate,
  type FactoryAgentCreateInput,
  type FactoryAgentSummary,
  type WorkflowStep,
  type WorkflowStepRunResult,
  type WorkflowCreateInput,
  type WorkflowUpdateInput,
} from "@paperclipai/shared";

/** Map an agent domain to the closest built-in agent role. */
const DOMAIN_ROLE: Record<string, string> = {
  it: "devops",
  hr: "general",
  finance: "cfo",
  procurement: "general",
  general: "general",
};

type Actor = { agentId?: string | null; userId?: string | null };

function normalizeSteps(steps: WorkflowStep[] | undefined): WorkflowStep[] {
  return (steps ?? []).map((s) => ({
    ...s,
    assigneeAgentId: s.assigneeAgentId ?? null,
    config: s.config ?? {},
  }));
}

/**
 * Simulated step executor. Each connector action resolves deterministically so a
 * workflow run produces a readable, auditable trace. Real connector adapters
 * (SAP/Workday/Jira API calls) plug in here behind the same interface.
 */
function executeStep(step: WorkflowStep): WorkflowStepRunResult {
  const action = getConnectorAction(step.connector, step.action);
  const label = action?.label ?? step.action;
  return {
    stepId: step.id,
    name: step.name,
    connector: step.connector,
    action: step.action,
    status: "succeeded",
    detail: `${label} completed${step.assigneeAgentId ? " (agent-assigned)" : ""}.`,
  };
}

export function agentsStudioService(db: Db) {
  return {
    listConnectors() {
      // Static catalog lives in shared; exposed for the studio palette.
      return undefined;
    },

    list: (companyId: string) =>
      db
        .select()
        .from(agentWorkflows)
        .where(eq(agentWorkflows.companyId, companyId))
        .orderBy(desc(agentWorkflows.updatedAt)),

    getById: (companyId: string, id: string) =>
      db
        .select()
        .from(agentWorkflows)
        .where(and(eq(agentWorkflows.companyId, companyId), eq(agentWorkflows.id, id)))
        .then((rows) => rows[0] ?? null),

    create: (companyId: string, data: WorkflowCreateInput, actor: Actor) =>
      db
        .insert(agentWorkflows)
        .values({
          companyId,
          name: data.name,
          description: data.description ?? null,
          status: data.status ?? "draft",
          steps: normalizeSteps(data.steps),
          templateKey: data.templateKey ?? null,
          tags: data.tags ?? [],
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
        })
        .returning()
        .then((rows) => rows[0]!),

    async update(companyId: string, id: string, data: WorkflowUpdateInput) {
      const patch: Partial<typeof agentWorkflows.$inferInsert> = { updatedAt: new Date() };
      if (data.name !== undefined) patch.name = data.name;
      if (data.description !== undefined) patch.description = data.description ?? null;
      if (data.status !== undefined) patch.status = data.status;
      if (data.steps !== undefined) patch.steps = normalizeSteps(data.steps);
      if (data.templateKey !== undefined) patch.templateKey = data.templateKey ?? null;
      if (data.tags !== undefined) patch.tags = data.tags;
      return db
        .update(agentWorkflows)
        .set(patch)
        .where(and(eq(agentWorkflows.companyId, companyId), eq(agentWorkflows.id, id)))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    remove: (companyId: string, id: string) =>
      db
        .delete(agentWorkflows)
        .where(and(eq(agentWorkflows.companyId, companyId), eq(agentWorkflows.id, id)))
        .returning()
        .then((rows) => rows[0] ?? null),

    deployTemplate(companyId: string, templateKey: string, name: string | undefined, actor: Actor) {
      const template = getWorkflowTemplate(templateKey);
      if (!template) return null;
      const steps: WorkflowStep[] = template.steps.map((s) => ({ ...s, assigneeAgentId: null }));
      return db
        .insert(agentWorkflows)
        .values({
          companyId,
          name: name ?? template.name,
          description: template.description,
          status: "active",
          steps,
          templateKey: template.key,
          tags: template.tags,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
        })
        .returning()
        .then((rows) => rows[0]!);
    },

    /**
     * Idempotently provision the AI Factory agent org for a company. Each
     * template member is tagged with metadata.factoryKey so re-running only
     * creates the members that are missing. The factory root attaches under an
     * existing company root agent if there is one, otherwise becomes a root.
     */
    async provisionOrg(companyId: string) {
      const existing = await db.select().from(agents).where(eq(agents.companyId, companyId));
      const byFactoryKey = new Map<string, (typeof existing)[number]>();
      for (const a of existing) {
        const key = (a.metadata as Record<string, unknown> | null)?.factoryKey;
        if (typeof key === "string") byFactoryKey.set(key, a);
      }

      // Attach the factory under an existing root (reportsTo === null) if present.
      const existingRoot = existing.find((a) => a.reportsTo === null) ?? null;

      const created: { key: string; id: string; name: string }[] = [];
      const idByKey = new Map<string, string>();
      for (const [key, agent] of byFactoryKey) idByKey.set(key, agent.id);

      // Insert in template order so parents exist before children.
      for (const member of AI_FACTORY_ORG_TEMPLATE) {
        if (byFactoryKey.has(member.key)) {
          idByKey.set(member.key, byFactoryKey.get(member.key)!.id);
          continue;
        }
        const reportsTo = member.reportsToKey
          ? idByKey.get(member.reportsToKey) ?? null
          : existingRoot?.id ?? null;
        const inserted = await db
          .insert(agents)
          .values({
            companyId,
            name: member.name,
            role: member.role,
            title: member.title,
            reportsTo,
            capabilities: member.capabilities,
            adapterType: "claude_local",
            status: "idle",
            metadata: { factoryKey: member.key, aiFactory: true, connector: member.connector },
          })
          .returning()
          .then((rows) => rows[0]!);
        idByKey.set(member.key, inserted.id);
        created.push({ key: member.key, id: inserted.id, name: inserted.name });
      }

      return {
        created,
        createdCount: created.length,
        skippedCount: AI_FACTORY_ORG_TEMPLATE.length - created.length,
        totalMembers: AI_FACTORY_ORG_TEMPLATE.length,
      };
    },

    /** Agents available to assign to workflow steps (factory-built first). */
    async listFactoryAgents(companyId: string): Promise<FactoryAgentSummary[]> {
      const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
      return rows
        .map((a) => {
          const meta = (a.metadata as Record<string, unknown> | null) ?? {};
          return {
            id: a.id,
            name: a.name,
            title: a.title,
            role: a.role,
            domain: typeof meta.domain === "string" ? meta.domain : null,
            allowedIntegrators: Array.isArray(meta.allowedIntegrators)
              ? (meta.allowedIntegrators as string[])
              : [],
            isFactoryBuilt: meta.aiFactoryAgent === true || meta.aiFactory === true,
          };
        })
        .sort((a, b) => Number(b.isFactoryBuilt) - Number(a.isFactoryBuilt) || a.name.localeCompare(b.name));
    },

    /** Create a specialized agent in the factory org (Agent Studio "Create Agent"). */
    async createFactoryAgent(companyId: string, input: FactoryAgentCreateInput) {
      const existing = await db.select().from(agents).where(eq(agents.companyId, companyId));
      const director = existing.find(
        (a) => (a.metadata as Record<string, unknown> | null)?.factoryKey === "director",
      );
      const root = existing.find((a) => a.reportsTo === null) ?? null;
      const reportsTo = director?.id ?? root?.id ?? null;
      const inserted = await db
        .insert(agents)
        .values({
          companyId,
          name: input.name,
          role: DOMAIN_ROLE[input.domain] ?? "general",
          title: `${input.domain.toUpperCase()} Agent`,
          reportsTo,
          capabilities: input.instructions || null,
          adapterType: "claude_local",
          status: "idle",
          metadata: {
            aiFactoryAgent: true,
            domain: input.domain,
            allowedIntegrators: input.allowedIntegrators,
          },
        })
        .returning()
        .then((rows) => rows[0]!);
      return inserted;
    },

    listRuns: (companyId: string, workflowId: string) =>
      db
        .select()
        .from(agentWorkflowRuns)
        .where(and(eq(agentWorkflowRuns.companyId, companyId), eq(agentWorkflowRuns.workflowId, workflowId)))
        .orderBy(desc(agentWorkflowRuns.createdAt)),

    async run(companyId: string, workflowId: string, trigger: string) {
      const workflow = await db
        .select()
        .from(agentWorkflows)
        .where(and(eq(agentWorkflows.companyId, companyId), eq(agentWorkflows.id, workflowId)))
        .then((rows) => rows[0] ?? null);
      if (!workflow) return null;

      const stepResults = (workflow.steps ?? []).map((step) => executeStep(step));
      const allOk = stepResults.every((r) => r.status === "succeeded");

      return db
        .insert(agentWorkflowRuns)
        .values({
          companyId,
          workflowId,
          status: allOk ? "succeeded" : "failed",
          trigger,
          stepResults,
          startedAt: new Date(),
          finishedAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]!);
    },
  };
}
