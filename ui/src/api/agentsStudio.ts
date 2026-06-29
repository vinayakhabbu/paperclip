import type {
  AgentWorkflow,
  AgentWorkflowRun,
  ConnectorDefinition,
  WorkflowCreateInput,
  WorkflowStep,
  WorkflowTemplate,
} from "@paperclipai/shared";
import { api } from "./client";

export const agentsStudioApi = {
  listConnectors: () => api.get<{ connectors: ConnectorDefinition[] }>(`/agents-studio/connectors`),

  listTemplates: () => api.get<{ templates: WorkflowTemplate[] }>(`/agents-studio/templates`),

  list: (companyId: string) =>
    api.get<{ workflows: AgentWorkflow[] }>(`/companies/${companyId}/workflows`),

  get: (companyId: string, id: string) =>
    api.get<{ workflow: AgentWorkflow }>(`/companies/${companyId}/workflows/${id}`),

  create: (companyId: string, data: WorkflowCreateInput) =>
    api.post<{ workflow: AgentWorkflow }>(`/companies/${companyId}/workflows`, data),

  update: (
    companyId: string,
    id: string,
    data: Partial<Pick<AgentWorkflow, "name" | "description" | "status"> & { steps: WorkflowStep[] }>,
  ) => api.patch<{ workflow: AgentWorkflow }>(`/companies/${companyId}/workflows/${id}`, data),

  remove: (companyId: string, id: string) =>
    api.delete<{ ok: true }>(`/companies/${companyId}/workflows/${id}`),

  deployTemplate: (companyId: string, templateKey: string, name?: string) =>
    api.post<{ workflow: AgentWorkflow }>(`/companies/${companyId}/workflows/deploy`, {
      templateKey,
      ...(name ? { name } : {}),
    }),

  listRuns: (companyId: string, id: string) =>
    api.get<{ runs: AgentWorkflowRun[] }>(`/companies/${companyId}/workflows/${id}/runs`),

  run: (companyId: string, id: string, trigger = "manual") =>
    api.post<{ run: AgentWorkflowRun }>(`/companies/${companyId}/workflows/${id}/run`, { trigger }),
};
