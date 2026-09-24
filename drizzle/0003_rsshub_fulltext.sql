ALTER TABLE "feed" ADD COLUMN "source" text DEFAULT 'rss' NOT NULL;--> statement-breakpoint
ALTER TABLE "feed" ADD COLUMN "rsshub_route" text;--> statement-breakpoint
ALTER TABLE "article" ADD COLUMN "full_fetched_at" timestamp;
