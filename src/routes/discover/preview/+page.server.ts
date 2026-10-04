import type { PageServerLoad } from './$types';
import { requireUser } from '$lib/server/guard';
import { discoverFeed, isTransientFeedError, type ParsedFeed } from '$lib/server/rss/parser';
import { listCollections } from '$lib/server/rss/refresh';

const PREVIEW_ITEMS = 10;

export interface PreviewItem {
	title: string;
	link: string;
	excerpt: string;
	author?: string;
	publishedAt: string | null;
	imageUrl: string | null;
}

export const load: PageServerLoad = async ({ url, locals }) => {
	const user = requireUser(locals);
	const feedUrl = (url.searchParams.get('url') ?? '').trim().slice(0, 2000);

	let collections: { id: number; name: string }[] = [];
	try {
		const rows = await listCollections(user.id);
		collections = rows.filter((c) => c.kind !== 'smart').map((c) => ({ id: c.id, name: c.name }));
	} catch (e) {
		console.error('preview collections load failed', e);
	}

	if (!feedUrl) {
		return {
			feedUrl: '',
			resolvedUrl: '',
			title: '',
			siteUrl: '',
			items: [],
			verified: false,
			error: 'Missing feed URL.' as string | null,
			collections
		};
	}
	try {
		new URL(feedUrl);
	} catch {
		return {
			feedUrl,
			resolvedUrl: '',
			title: '',
			siteUrl: '',
			items: [],
			verified: false,
			error: 'That URL is not valid.' as string | null,
			collections
		};
	}

	try {
		const discovery = await discoverFeed(feedUrl);
		const parsed: ParsedFeed | null = discovery.parsed;
		let feed = parsed;
		if (!feed) {
			// discoverFeed only verifies direct + well-known paths + radar hits;
			// fall through with an unverified notice instead of refetching here.
			const blocked = discovery.transient && !discovery.radarFailed;
			return {
				feedUrl,
				resolvedUrl: discovery.url,
				title: '',
				siteUrl: '',
				items: [],
				verified: false,
				error: (blocked
					? 'This site blocks automated fetching (bot protection) so no preview is available. You can still follow it. The scheduled refresh keeps retrying in the background.'
					: discovery.radarFailed
						? 'Could not load this feed right now. The feed server may be down. You can still follow it and let the refresh retry.'
						: 'No readable feed found at that URL.') as string | null,
				collections
			};
		}
		const items: PreviewItem[] = feed.items.slice(0, PREVIEW_ITEMS).map((it) => ({
			title: it.title,
			link: it.link,
			excerpt: it.excerpt,
			author: it.author,
			publishedAt: it.publishedAt ? it.publishedAt.toISOString() : null,
			imageUrl: it.imageUrl ?? null
		}));
		return {
			feedUrl,
			resolvedUrl: discovery.url,
			title: feed.title,
			siteUrl: feed.siteUrl ?? '',
			items,
			verified: true,
			error: null as string | null,
			collections
		};
	} catch (e) {
		console.error('preview load failed', e);
		const transient = isTransientFeedError(e);
		return {
			feedUrl,
			resolvedUrl: feedUrl,
			title: '',
			siteUrl: '',
			items: [],
			verified: false,
			error: (transient
				? 'Could not load this feed right now. It may be temporarily unreachable. You can still follow it and let the refresh retry.'
				: 'No readable feed found at that URL.') as string | null,
			collections
		};
	}
};
