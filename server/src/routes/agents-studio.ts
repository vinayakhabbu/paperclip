import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  CONNECTOR_CATALOG,
  WORKFLOW_TEMPLATES,
  workflowCreateSchema,
  workflowUpdateSchema,
  workflowDeployTemplateSchema,
  workflowRunCreateSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { agentsStudioService } from "../services/index.js";
import { notFound } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function agentsStudioRoutes(db: Db) {
  const router = Router();
  const svc = agentsStudioService(db);

  function actorOf(req: Parameters<typeof getActorInfo>[0]) {
    const info = getActorInfo(req);
    return { agentId: info.agentId, userId: info.actorType === "user" ? info.actorId : null };
  }

  // Static catalogs — connector palette + deployable templates (no company scope).
  router.get("/agents-studio/connectors", (_req, res) => {
    res.json({ connectors: CONNECTOR_CATALOG });
  });

  router.get("/agents-studio/templates", (_req, res) => {
    res.json({ templates: WORKFLOW_TEMPLATES });
  });

  router.post("/companies/:companyId/agents-studio/provision-org", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.provisionOrg(companyId);
    res.status(201).json(result);
  });

  router.get("/companies/:companyId/workflows", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ workflows: await svc.list(companyId) });
  });

  router.post("/companies/:companyId/workflows", validate(workflowCreateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const workflow = await svc.create(companyId, req.body, actorOf(req));
    res.status(201).json({ workflow });
  });

  router.post(
    "/companies/:companyId/workflows/deploy",
    validate(workflowDeployTemplateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const workflow = await svc.deployTemplate(companyId, req.body.templateKey, req.body.name, actorOf(req));
      if (!workflow) throw notFound("Unknown template");
      res.status(201).json({ workflow });
    },
  );

  router.get("/companies/:companyId/workflows/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, companyId);
    const workflow = await svc.getById(companyId, id);
    if (!workflow) throw notFound("Workflow not found");
    res.json({ workflow });
  });

  router.patch(
    "/companies/:companyId/workflows/:id",
    validate(workflowUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
    const id = req.params.id as string;
      assertCompanyAccess(req, companyId);
      const workflow = await svc.update(companyId, id, req.body);
      if (!workflow) throw notFound("Workflow not found");
      res.json({ workflow });
    },
  );

  router.delete("/companies/:companyId/workflows/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, companyId);
    const removed = await svc.remove(companyId, id);
    if (!removed) throw notFound("Workflow not found");
    res.json({ ok: true });
  });

  router.get("/companies/:companyId/workflows/:id/runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    assertCompanyAccess(req, companyId);
    res.json({ runs: await svc.listRuns(companyId, id) });
  });

  router.post(
    "/companies/:companyId/workflows/:id/run",
    validate(workflowRunCreateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
    const id = req.params.id as string;
      assertCompanyAccess(req, companyId);
      const run = await svc.run(companyId, id, req.body.trigger);
      if (!run) throw notFound("Workflow not found");
      res.status(201).json({ run });
    },
  );

  return router;
}
