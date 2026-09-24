-- Per-user isolation: old global feeds have no owner and can't be assigned.
-- Wipe them (cascades to articles via feed_id FK, then to user_article_state
-- via article_id FK, and to subscriptions via feed_id FK) so the NOT NULL
-- user_id column can be added cleanly. New accounts start empty.
DELETE FROM "feed";--> statement-breakpoint
ALTER TABLE "feed" DROP CONSTRAINT "feed_url_unique";--> statement-breakpoint
ALTER TABLE "feed" ADD COLUMN "user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "feed" ADD CONSTRAINT "feed_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feed_user_url_idx" ON "feed" USING btree ("user_id","url");--> statement-breakpoint
CREATE INDEX "feed_user_idx" ON "feed" USING btree ("user_id");