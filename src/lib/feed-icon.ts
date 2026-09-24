/** Resolve a display icon for a feed: stored image first, favicon fallback second. */
export function faviconUrl(siteUrl?: string | null, feedUrl?: string | null): string | null {
	const raw = siteUrl?.trim() || feedUrl?.trim();
	if (!raw) return null;
	try {
		const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
		const host = new URL(withProto).hostname;
		if (!host) return null;
		return `https://www.google.com/s2/favicons?domain=${host}&sz=64`;
	} catch {
		return null;
	}
}

export function feedDisplayIcon(feed: {
	imageUrl?: string | null;
	siteUrl?: string | null;
	url?: string | null;
}): string | null {
	if (feed.imageUrl?.trim()) return feed.imageUrl;
	return faviconUrl(feed.siteUrl, feed.url);
}
