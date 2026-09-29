import { db } from '$lib/server/db';
import { userViewPref } from '$lib/server/db/feeds.schema';
import { eq } from 'drizzle-orm';
import type { ArticleView } from '$lib/article.js';

export function isArticleView(value: unknown): value is ArticleView {
	return value === 'list' || value === 'grid' || value === 'compact' || value === 'magazine';
}

export async function getViewPrefs(userId: string): Promise<Record<string, ArticleView>> {
	const rows = await db
		.select({ scope: userViewPref.scope, view: userViewPref.view })
		.from(userViewPref)
		.where(eq(userViewPref.userId, userId));
	const prefs: Record<string, ArticleView> = {};
	for (const row of rows) {
		if (isArticleView(row.view)) prefs[row.scope] = row.view;
	}
	return prefs;
}

export async function setViewPref(userId: string, scope: string, view: ArticleView): Promise<void> {
	if (!scope || scope.length > 64 || !isArticleView(view)) return;
	await db
		.insert(userViewPref)
		.values({ userId, scope, view })
		.onConflictDoUpdate({
			target: [userViewPref.userId, userViewPref.scope],
			set: { view, updatedAt: new Date() }
		});
}
