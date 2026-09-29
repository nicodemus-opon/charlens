CREATE TABLE "user_view_pref" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"view" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_view_pref" ADD CONSTRAINT "user_view_pref_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_view_pref_user_scope_idx" ON "user_view_pref" USING btree ("user_id","scope");--> statement-breakpoint
CREATE INDEX "user_view_pref_user_idx" ON "user_view_pref" USING btree ("user_id");