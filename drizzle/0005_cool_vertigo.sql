CREATE TABLE "article_embedding" (
	"article_id" integer PRIMARY KEY NOT NULL,
	"embedding" jsonb,
	"topics" jsonb,
	"entities" jsonb,
	"embedded_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "article_event" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"article_id" integer NOT NULL,
	"kind" text NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_interest" (
	"user_id" text PRIMARY KEY NOT NULL,
	"embedding" jsonb,
	"topic_prefs" jsonb,
	"source_prefs" jsonb,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_article_state" ADD COLUMN "open_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_article_state" ADD COLUMN "last_opened_at" timestamp;--> statement-breakpoint
ALTER TABLE "user_article_state" ADD COLUMN "total_dwell_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_article_state" ADD COLUMN "max_scroll_pct" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_article_state" ADD COLUMN "finished" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "article_embedding" ADD CONSTRAINT "article_embedding_article_id_article_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."article"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_event" ADD CONSTRAINT "article_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_event" ADD CONSTRAINT "article_event_article_id_article_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."article"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_interest" ADD CONSTRAINT "user_interest_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "article_embedding_embedded_idx" ON "article_embedding" USING btree ("embedded_at");--> statement-breakpoint
CREATE INDEX "article_event_user_created_idx" ON "article_event" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "article_event_article_idx" ON "article_event" USING btree ("article_id");