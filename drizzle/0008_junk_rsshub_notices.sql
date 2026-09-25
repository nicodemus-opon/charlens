-- Cleanup: junk feeds created through mis-resolved RSSHub radar routes.
-- Before the strict radar-matcher fix, pasting a site/topic page could persist
-- an unrelated RSSHub route URL onto the feed row. RSSHub's own meta-feed
-- carries the FEED title "RSSHub has new routes" (its items are normal titles
-- like "YouTube - Live" with authors like "sussurr127"), so matching on
-- article.title hit zero rows. Match the parent feed title instead and delete
-- the whole junk feed; its articles go via FK cascade. Real user feeds are
-- untouched. The FK-less recommend_score_log is cleaned explicitly.
DELETE FROM "recommend_score_log" WHERE "article_id" IN (SELECT "article"."id" FROM "article" JOIN "feed" ON "feed"."id" = "article"."feed_id" WHERE "feed"."title" ILIKE '%rsshub has new routes%');
--> statement-breakpoint
DELETE FROM "subscription" WHERE "feed_id" IN (SELECT "id" FROM "feed" WHERE "title" ILIKE '%rsshub has new routes%');
--> statement-breakpoint
DELETE FROM "feed" WHERE "title" ILIKE '%rsshub has new routes%';
