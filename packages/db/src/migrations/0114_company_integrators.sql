CREATE TABLE IF NOT EXISTS "company_integrators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"integrator_key" text NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_integrators" ADD CONSTRAINT "company_integrators_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_integrators_company_key_uq" ON "company_integrators" USING btree ("company_id","integrator_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_integrators_company_status_idx" ON "company_integrators" USING btree ("company_id","status");
