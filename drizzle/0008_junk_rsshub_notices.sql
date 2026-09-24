-- Cleanup: junk items pulled in through mis-resolved RSSHub radar routes.
-- Before the strict radar-matcher fix, pasting a site/topic page could persist
-- an unrelated RSSHub route URL onto the feed row, whose items (notably the
-- recurring "RSSHub has new routes" notices) then surfaced in Today/Recommended.
-- This deletes only those notice articles (per-user feeds are untouched).
-- Dependent rows (embeddings, states, events, tags) cascade via FK; the
-- FK-less recommend_score_log is cleaned explicitly.
DELETE FROM "recommend_score_log" WHERE "article_id" IN (SELECT "id" FROM "article" WHERE "title" ILIKE '%rsshub has new routes%');
--> statement-breakpoint
DELETE FROM "article" WHERE "title" ILIKE '%rsshub has new routes%';
