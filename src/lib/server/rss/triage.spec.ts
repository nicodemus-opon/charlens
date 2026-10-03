import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '$lib/server/db';
import { user } from '$lib/server/db/auth.schema';
import { article, feed, subscription, userArticleState } from '$lib/server/db/feeds.schema';
import { markRead, markScopeRead, toggleRead, toggleSaved } from './refresh';

const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let n = 0;
const ownedUsers: string[] = [];

async function mkUser(): Promise<string> {
	const id = `triage-${runId}-${n}`;
	const email = `triage-${runId}-${n}@example.com`;
	n += 1;
	ownedUsers.push(id);
	await db.insert(user).values({ id, name: 'triage', email });
	return id;
}

/** A subscribed feed with `count` fresh articles; returns feed + article ids. */
async function mkFeed(
	userId: string,
	opts: { articles?: { title: string; ageMs?: number }[] } = {}
): Promise<{ feedId: number; articleIds: number[] }> {
	const k = `${runId}-${n}-${Math.floor(Math.random() * 1e6)}`;
	n += 1;
	const [f] = await db
		.insert(feed)
		.values({ userId, url: `https://example.com/${k}.xml`, title: `Feed ${k}` })
		.returning({ id: feed.id });
	await db.insert(subscription).values({ userId, feedId: f.id });
	const articleIds: number[] = [];
	for (const [i, a] of (opts.articles ?? [{ title: 'Hello' }]).entries()) {
		const at = new Date(Date.now() - (a.ageMs ?? 0));
		const [row] = await db
			.insert(article)
			.values({
				feedId: f.id,
				guid: `guid-${k}-${i}`,
				title: a.title,
				link: `https://example.com/${k}/${i}`,
				publishedAt: at,
				createdAt: at
			})
			.returning({ id: article.id });
		articleIds.push(row.id);
	}
	return { feedId: f.id, articleIds };
}

async function isRead(userId: string, articleId: number): Promise<boolean> {
	const rows = await db
		.select({ isRead: userArticleState.isRead })
		.from(userArticleState)
		.where(and(eq(userArticleState.userId, userId), eq(userArticleState.articleId, articleId)))
		.limit(1);
	return rows[0]?.isRead ?? false;
}

afterEach(async () => {
	// Feed/article/state/subscription rows cascade off the user delete.
	for (const id of ownedUsers.splice(0)) {
		await db.delete(user).where(eq(user.id, id));
	}
});

describe('markScopeRead', () => {
	it('marks the today window and reports only newly-marked rows', async () => {
		const uid = await mkUser();
		const { articleIds } = await mkFeed(uid, {
			articles: [
				{ title: 'Fresh one' },
				{ title: 'Fresh two' },
				{ title: 'Old backlog', ageMs: 3 * 86400000 }
			]
		});
		await markRead(uid, articleIds[0], true);
		const { marked } = await markScopeRead(uid, { filter: 'today' });
		expect(marked).toBe(1);
		expect(await isRead(uid, articleIds[0])).toBe(true);
		expect(await isRead(uid, articleIds[1])).toBe(true);
		expect(await isRead(uid, articleIds[2])).toBe(false);
	});

	it('returns zero when nothing is unread', async () => {
		const uid = await mkUser();
		const { articleIds } = await mkFeed(uid);
		await markRead(uid, articleIds[0], true);
		expect(await markScopeRead(uid, { filter: 'today' })).toEqual({ marked: 0 });
	});

	it('never touches another user’s articles', async () => {
		const a = await mkUser();
		const b = await mkUser();
		const mine = await mkFeed(a);
		const theirs = await mkFeed(b);
		const { marked } = await markScopeRead(a, { filter: 'all' });
		expect(marked).toBe(1);
		expect(await isRead(a, mine.articleIds[0])).toBe(true);
		expect(await isRead(b, theirs.articleIds[0])).toBe(false);
	});

	it('restricts to one feed when feedId is given', async () => {
		const uid = await mkUser();
		const first = await mkFeed(uid);
		const second = await mkFeed(uid);
		const { marked } = await markScopeRead(uid, { filter: 'all', feedId: first.feedId });
		expect(marked).toBe(1);
		expect(await isRead(uid, first.articleIds[0])).toBe(true);
		expect(await isRead(uid, second.articleIds[0])).toBe(false);
	});

	it('restricts to saved articles for the saved filter', async () => {
		const uid = await mkUser();
		const { articleIds } = await mkFeed(uid, {
			articles: [{ title: 'Keep me' }, { title: 'Skip me' }]
		});
		await toggleSaved(uid, articleIds[0]);
		const { marked } = await markScopeRead(uid, { filter: 'saved' });
		expect(marked).toBe(1);
		expect(await isRead(uid, articleIds[0])).toBe(true);
		expect(await isRead(uid, articleIds[1])).toBe(false);
	});

	it('honors smart-view rules like the list does', async () => {
		const uid = await mkUser();
		const { articleIds } = await mkFeed(uid, {
			articles: [{ title: 'Linux kernel 6.9 released' }, { title: 'Sourdough starter guide' }]
		});
		const { marked } = await markScopeRead(uid, {
			filter: 'all',
			smart: { keywords: ['linux'], unreadOnly: true }
		});
		expect(marked).toBe(1);
		expect(await isRead(uid, articleIds[0])).toBe(true);
		expect(await isRead(uid, articleIds[1])).toBe(false);
	});

	it('matches the keyword query the list applies', async () => {
		const uid = await mkUser();
		const { articleIds } = await mkFeed(uid, {
			articles: [{ title: 'Linux kernel 6.9 released' }, { title: 'Sourdough starter guide' }]
		});
		const { marked } = await markScopeRead(uid, { filter: 'all', query: 'sourdough' });
		expect(marked).toBe(1);
		expect(await isRead(uid, articleIds[0])).toBe(false);
		expect(await isRead(uid, articleIds[1])).toBe(true);
	});

	it('marks the recommended ranking window, not the chronological list', async () => {
		const uid = await mkUser();
		const { articleIds } = await mkFeed(uid, {
			articles: [{ title: 'One' }, { title: 'Two' }]
		});
		const { marked } = await markScopeRead(uid, { filter: 'recommended' });
		expect(marked).toBe(2);
		expect(await isRead(uid, articleIds[0])).toBe(true);
		expect(await isRead(uid, articleIds[1])).toBe(true);
	});

	it('caps at the list window like the rendered view', async () => {
		const uid = await mkUser();
		const { articleIds } = await mkFeed(uid, {
			articles: [
				{ title: 'Newest' },
				{ title: 'Middle', ageMs: 3600000 },
				{ title: 'Oldest', ageMs: 7200000 }
			]
		});
		const { marked } = await markScopeRead(uid, { filter: 'all', limit: 2 });
		expect(marked).toBe(2);
		expect(await isRead(uid, articleIds[0])).toBe(true);
		expect(await isRead(uid, articleIds[1])).toBe(true);
		expect(await isRead(uid, articleIds[2])).toBe(false);
	});
});

describe('toggleRead', () => {
	it('flips unread to read and back, reporting the new state', async () => {
		const uid = await mkUser();
		const { articleIds } = await mkFeed(uid);
		const id = articleIds[0];
		expect(await toggleRead(uid, id)).toBe(true);
		expect(await isRead(uid, id)).toBe(true);
		expect(await toggleRead(uid, id)).toBe(false);
		expect(await isRead(uid, id)).toBe(false);
	});

	it('refuses articles owned by another user', async () => {
		const a = await mkUser();
		const b = await mkUser();
		const { articleIds } = await mkFeed(b);
		expect(await toggleRead(a, articleIds[0])).toBe(false);
		expect(await isRead(b, articleIds[0])).toBe(false);
	});

	it('refuses unknown articles without throwing', async () => {
		const uid = await mkUser();
		await mkFeed(uid);
		expect(await toggleRead(uid, 999999999)).toBe(false);
	});
});
