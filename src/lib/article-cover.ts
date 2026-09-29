import { Avatar, Style } from '@dicebear/core';
import waves from '@dicebear/styles/waves.json';

/**
 * Deterministic cover art for articles without an image, via DiceBear's
 * `waves` style (soft horizontal bands, CC0) — chosen because it never reads
 * as an icon or glyph, unlike geometric-figure styles.
 *
 * Same article → same data URI on server and client (no hydration drift, no
 * network, fully offline). The palettes below approximate the theme tokens in
 * `src/routes/layout.css` (oklch → hex), kept close to the app background so
 * covers sit quietly beside real photos.
 */

export interface ArtSeed {
	id: number;
	feedTitle: string;
	title?: string | null;
}

/** Stable seed string — the DiceBear PRNG derives everything from this. */
export function articleSeedString(article: ArtSeed): string {
	return `${article.id}:${article.feedTitle}:${article.title ?? ''}`;
}

/**
 * Minimum intrinsic width for a remote cover to be shown. Anything smaller is
 * a site icon / favicon / tracking pixel that would upscale into a blurry
 * glyph — those fall back to the generated cover instead.
 */
export const MIN_COVER_WIDTH = 200;

/** True when a loaded remote cover is big enough to show without upscaling. */
export function isUsableCoverWidth(naturalWidth: number): boolean {
	return naturalWidth >= MIN_COVER_WIDTH;
}

/** Quiet grounds close to --background/--muted/--chart-1/--chart-3 tints. */
export const COVER_BACKGROUNDS = [
	'f1ebed',
	'e9edf3',
	'f3ede1',
	'eae8f1',
	'e8eef0',
	'f5eee8'
] as const;

/** Muted wave tones — tone-on-tone with the grounds, never saturated. */
export const COVER_SHAPES = ['d9c2cc', 'bcc6e2', 'd8cba8', 'c3b8d9', 'b3c9d9', 'e0c4a8'] as const;

/**
 * Dark-mode grounds close to the dark --background/--muted range
 * (oklch ~0.22-0.31): deep plum-charcoal tints.
 */
export const COVER_BACKGROUNDS_DARK = [
	'2c2530',
	'232b3a',
	'2e2a24',
	'262b36',
	'322c38',
	'263234'
] as const;

/** Dark-mode wave tones — a half-step lighter than the grounds. */
export const COVER_SHAPES_DARK = [
	'4d414d',
	'3e475e',
	'4e463a',
	'3c4757',
	'524757',
	'3e4c4c'
] as const;

export type CoverScheme = 'light' | 'dark';

const style = new Style(waves);

const cache = new Map<string, string>();

export function getCoverDataUri(seed: ArtSeed, scheme: CoverScheme = 'light'): string {
	const key = `${scheme}:${articleSeedString(seed)}`;
	const hit = cache.get(key);
	if (hit) return hit;
	const dark = scheme === 'dark';
	const uri = new Avatar(style, {
		seed: articleSeedString(seed),
		backgroundColor: [...(dark ? COVER_BACKGROUNDS_DARK : COVER_BACKGROUNDS)],
		waveColor: [...(dark ? COVER_SHAPES_DARK : COVER_SHAPES)]
	}).toDataUri();
	if (cache.size > 1000) cache.clear();
	cache.set(key, uri);
	return uri;
}
