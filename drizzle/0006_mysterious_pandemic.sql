CREATE TABLE "recommend_score_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"article_id" integer NOT NULL,
	"score" real NOT NULL,
	"components" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "recommend_score_log_user_created_idx" ON "recommend_score_log" USING btree ("user_id","created_at");