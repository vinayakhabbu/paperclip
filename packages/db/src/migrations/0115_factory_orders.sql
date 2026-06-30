CREATE TABLE IF NOT EXISTS "factory_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"domain" text DEFAULT 'general' NOT NULL,
	"stage" text DEFAULT 'intake' NOT NULL,
	"description" text,
	"produced_workflow_id" uuid,
	"produced_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "factory_orders" ADD CONSTRAINT "factory_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "factory_orders_company_stage_idx" ON "factory_orders" USING btree ("company_id","stage");
