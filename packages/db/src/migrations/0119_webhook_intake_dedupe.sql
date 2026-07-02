CREATE UNIQUE INDEX "issues_webhook_intake_uq" ON "issues" ("company_id","origin_kind","origin_id")
  WHERE "origin_kind" = 'webhook_intake' AND "origin_id" IS NOT NULL AND "hidden_at" IS NULL;
