CREATE TABLE IF NOT EXISTS "agent_workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"template_key" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"step_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_workflows" ADD CONSTRAINT "agent_workflows_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_workflow_runs" ADD CONSTRAINT "agent_workflow_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_workflow_runs" ADD CONSTRAINT "agent_workflow_runs_workflow_id_agent_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."agent_workflows"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_workflows_company_status_idx" ON "agent_workflows" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_workflows_company_template_idx" ON "agent_workflows" USING btree ("company_id","template_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_workflow_runs_company_workflow_idx" ON "agent_workflow_runs" USING btree ("company_id","workflow_id","created_at");
