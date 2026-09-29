CREATE TABLE "user_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"article_id" integer,
	"feed_id" integer,
	"topic" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_feedback_user_created_idx" ON "user_feedback" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "article_feed_idx" ON "article" USING btree ("feed_id");--> statement-breakpoint
CREATE INDEX "article_published_idx" ON "article" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "article_created_idx" ON "article" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "user_article_state_user_updated_idx" ON "user_article_state" USING btree ("user_id","updated_at");