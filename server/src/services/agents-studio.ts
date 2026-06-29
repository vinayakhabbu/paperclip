import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWorkflowRuns, agentWorkflows } from "@paperclipai/db";
import {
  getConnectorAction,
  getWorkflowTemplate,
  type WorkflowStep,
  type WorkflowStepRunResult,
  type WorkflowCreateInput,
  type WorkflowUpdateInput,
} from "@paperclipai/shared";

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
