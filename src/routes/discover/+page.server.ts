import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireUser } from '$lib/server/guard';
import { addFeed, listCollections, populateFeed } from '$lib/server/rss/refresh';
import {
	getDiscoveryContext,
	isUrlLike,
	rankCandidates,
	searchDiscovery,
	verifyWebFeeds,
	type DiscoverCandidate,
	type DiscoverSort
} from '$lib/server/rss/discovery';
import {
	getRadarCandidates,
	isRsshubEnabled,
	radarDisplayName,
	resolveCandidateUrl,
	rsshubHealth
} from '$lib/server/rss/rsshub';
import { checkDirectFeed, discoverAllSiteFeeds, fetchFeedTitle } from '$lib/server/rss/parser';
import { parseLocale } from '$lib/server/rss/feed-search';

const SORTS: DiscoverSort[] = ['best', 'relevance', 'az'];
const PAGE_SIZE = 15;
const FETCH_LIMIT = 100;

function toQueryUrl(raw: string): string | null {
	const q = raw.trim();
	if (!q) return null;
	try {
		if (/^https?:\/\//i.test(q)) return new URL(q).toString();
		return new URL(`https://${q}`).toString();
	} catch {
		return null;
	}
}

export const load: PageServerLoad = async ({ url, locals, request }) => {
	const user = requireUser(locals);
	const q = (url.searchParams.get('q') ?? '').trim().slice(0, 300);
	const rawSort = url.searchParams.get('sort') ?? 'best';
	const sort: DiscoverSort = SORTS.includes(rawSort as DiscoverSort)
		? (rawSort as DiscoverSort)
		: 'best';
	const rawPage = Number(url.searchParams.get('page') ?? '1');
	const requestedPage = Number.isFinite(rawPage) ? Math.max(1, Math.floor(rawPage)) : 1;

	function paginate<T>(ranked: T[]): {
		listed: T[];
		total: number;
		page: number;
		totalPages: number;
	} {
		const total = ranked.length;
		const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
		const page = Math.min(requestedPage, totalPages);
		return {
			listed: ranked.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
			total,
			page,
			totalPages
		};
	}
	// Region for the web publisher search comes from the browser locale
	// (e.g. en-KE → Kenyan outlets first for topic queries).
	const locale = parseLocale(request.headers.get('accept-language'));

	let rsshubOk = isRsshubEnabled();
	try {
		const health = await rsshubHealth();
		rsshubOk = health.ok;
	} catch {
		rsshubOk = false;
	}

	let collections: { id: number; name: string }[] = [];
	try {
		const rows = await listCollections(user.id);
		collections = rows.filter((c) => c.kind !== 'smart').map((c) => ({ id: c.id, name: c.name }));
	} catch (e) {
		console.error('discover collections load failed', e);
	}

	if (!q) {
		let topics: string[] = [];
		try {
			topics = (await getDiscoveryContext(user.id)).tagNames.slice(0, 12);
		} catch (e) {
			console.error('discover topics load failed', e);
		}
		return {
			q,
			sort,
			mode: 'empty' as const,
			candidates: [] as DiscoverCandidate[],
			topics,
			total: 0,
			page: 1,
			pageSize: PAGE_SIZE,
			totalPages: 1,
			failed: false,
			rsshubOk,
			collections
		};
	}

	// URL flow: direct-feed option + every verified native site feed
	// (declared `<link rel="alternate">`, well-known paths, curated section
	// feeds for bot-walled hosts) + all radar candidates. Pasted site roots
	// list the whole domain so e.g. bloomberg.com shows each section feed.
	if (isUrlLike(q)) {
		const ctx = await getDiscoveryContext(user.id);
		const direct = toQueryUrl(q);
		const candidates: DiscoverCandidate[] = [];
		const seenUrls = new Set<string>();
		let host = q;
		if (direct) {
			try {
				host = new URL(direct).hostname;
			} catch {
				// keep raw input as label
			}
		}
		// The three lookups are independent — run them together. The direct
		// check classifies the pasted URL itself so an HTML page (channel,
		// article, site root) doesn't get a redundant "Direct feed" row when
		// real feeds were found.
		const [directCheck, siteFeeds, radarResult] = await Promise.all([
			direct ? checkDirectFeed(direct) : Promise.resolve(null),
			discoverAllSiteFeeds(q).catch((e) => {
				console.error('discover site feeds lookup failed', e);
				return [];
			}),
			getRadarCandidates(q, { limit: 20 }).catch((e) => {
				console.error('discover radar lookup failed', e);
				return { candidates: [], failed: true } as const;
			})
		]);
		const failed = radarResult.failed;
		for (const f of siteFeeds) {
			if (!f.url || seenUrls.has(f.url)) continue;
			seenUrls.add(f.url);
			let feedHost = host;
			try {
				feedHost = new URL(f.url).hostname;
			} catch {
				// keep site host as label
			}
			candidates.push({
				id: `site:${f.url}`,
				routePath: '',
				title: f.title || f.url,
				namespace: 'rss',
				domain: feedHost,
				url: f.url,
				needsParams: false,
				score: 1.5,
				subscribed: false,
				muted: false
			});
		}
		for (const c of radarResult.candidates) {
			const resolved = resolveCandidateUrl(c);
			candidates.push({
				id: `${q}${c.routePath}`,
				routePath: c.routePath,
				title: radarDisplayName(c),
				namespace: c.routePath.split('/').filter(Boolean)[0]?.toLowerCase() ?? '',
				domain: q,
				docs: c.docs,
				url: resolved ?? '',
				needsParams: c.needsParams && !resolved,
				prefill: c.prefill,
				score: resolved ? 1 : 0,
				subscribed: false,
				muted: false
			});
		}
		// Best-effort real channel/feed names for resolved Radar routes: a
		// pasted handle shows the channel name, not "Channel with user
		// handle". Capped and budgeted so cold RSSHub routes can't stall the
		// page; failures keep the prefill-derived name above.
		const titleTargets = candidates.filter((c) => c.routePath !== '' && c.url !== '');
		const titles = await Promise.all(titleTargets.slice(0, 5).map((c) => fetchFeedTitle(c.url)));
		titles.forEach((t, i) => {
			if (t) titleTargets[i].title = t;
		});
		// Show the pasted URL itself only when it is (or may be) a feed: a
		// verified feed always; otherwise only when nothing better was found
		// (the user can still follow it and let refresh retry). A redundant
		// "Direct feed" row next to real results is never shown.
		if (direct && directCheck && !seenUrls.has(direct)) {
			const hasAlternative =
				siteFeeds.length > 0 || radarResult.candidates.some((c) => resolveCandidateUrl(c) !== null);
			if (directCheck.status === 'ok' || !hasAlternative) {
				candidates.push({
					id: `direct:${direct}`,
					routePath: '',
					title: directCheck.title || host,
					namespace: 'rss',
					domain: host,
					url: direct,
					needsParams: false,
					score: 2,
					subscribed: false,
					muted: false
				});
				seenUrls.add(direct);
			}
		}
		const ranked = rankCandidates(candidates, q, ctx, sort);
		const paged = paginate(ranked);
		return {
			q,
			sort,
			mode: 'url' as const,
			candidates: paged.listed,
			topics: [] as string[],
			total: paged.total,
			page: paged.page,
			pageSize: PAGE_SIZE,
			totalPages: paged.totalPages,
			failed,
			rsshubOk,
			collections
		};
	}

	// Keyword flow: web publisher search, interest-ranked. Feed
	// verification streams separately so the page renders first and cards
	// flip to Preview/No-feed as results land.
	const { candidates, failed } = await searchDiscovery(q, user.id, {
		limit: FETCH_LIMIT,
		sort,
		lang: locale.lang,
		region: locale.region
	});
	const paged = paginate(candidates);
	const verified = verifyWebFeeds(paged.listed.map((c) => ({ id: c.id, siteUrl: c.url })));
	// Warm the verification cache for the next page while the user reads
	// this one: fire-and-forget (never blocks the response). If the host
	// drops background work the next page simply verifies on demand.
	const upcoming = candidates.slice(paged.page * PAGE_SIZE, (paged.page + 1) * PAGE_SIZE);
	if (upcoming.length > 0) {
		void verifyWebFeeds(upcoming.map((c) => ({ id: c.id, siteUrl: c.url }))).catch(() => {});
	}
	return {
		q,
		sort,
		mode: 'keyword' as const,
		candidates: paged.listed,
		verified,
		topics: [] as string[],
		total: paged.total,
		page: paged.page,
		pageSize: PAGE_SIZE,
		totalPages: paged.totalPages,
		failed,
		rsshubOk,
		collections
	};
};

export const actions: Actions = {
	follow: async ({ request, locals, platform }) => {
		const user = requireUser(locals);
		const form = await request.formData();
		const directUrl = String(form.get('url') ?? '').trim();
		const routePath = String(form.get('routePath') ?? '').trim();
		const collectionRaw = form.get('collection') ?? 'General';
		const collectionRef =
			typeof collectionRaw === 'string' && /^\d+$/.test(collectionRaw.trim())
				? Number(collectionRaw)
				: String(collectionRaw).trim() || 'General';

		let feedUrl = directUrl;
		if (!feedUrl && routePath) {
			let prefill: Record<string, string> | undefined;
			const rawPrefill = String(form.get('prefill') ?? '').trim();
			if (rawPrefill) {
				try {
					const parsed: unknown = JSON.parse(rawPrefill);
					if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
						prefill = parsed as Record<string, string>;
					}
				} catch {
					return fail(400, { message: 'Invalid route parameters.' });
				}
			}
			const resolved = resolveCandidateUrl({ routePath, url: '', prefill });
			if (!resolved)
				return fail(400, { message: 'This route needs details. Open its docs first.' });
			feedUrl = resolved;
		}
		if (!feedUrl) return fail(400, { message: 'Missing feed URL.' });
		try {
			new URL(feedUrl);
		} catch {
			return fail(400, { message: 'Enter a valid URL.' });
		}
		let feedId: number;
		try {
			feedId = await addFeed(user.id, feedUrl, collectionRef);
		} catch (e) {
			console.error('discover follow failed', e);
			return fail(400, { message: 'Could not add feed.' });
		}
		const background = populateFeed(feedId, feedUrl);
		(
			platform as { context?: { waitUntil?: (p: Promise<unknown>) => void } } | undefined
		)?.context?.waitUntil?.(background);
		throw redirect(303, '/?filter=all');
	}
};
