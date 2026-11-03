import type { RequestHandler } from './$types';
import { handleOptions, send } from '$lib/server/api/guard';
import { json } from '@sveltejs/kit';

export const OPTIONS: RequestHandler = async ({ request }) => handleOptions(request);

const ARTICLE_FILTERS = ['today', 'saved', 'all', 'recommended'];

function route(
	path: string,
	methods: Record<string, { summary: string; auth: string; extra?: Record<string, unknown> }>
) {
	const out: Record<string, unknown> = {};
	for (const [method, def] of Object.entries(methods)) {
		out[method] = {
			summary: def.summary,
			security: def.auth === 'none' ? [] : [{ bearerAuth: [] }],
			...def.extra
		};
	}
	return { [path]: out };
}

/** Public, versioned contract for the v1 API (hand-maintained). */
export const GET: RequestHandler = async ({ request }) => {
	const spec = {
		openapi: '3.0.3',
		info: {
			title: 'charlens public API',
			version: '1.0.0',
			description:
				'Self-hosted multi-user RSS reader API. Auth: `Authorization: Bearer <token>` (Settings → API tokens) or session cookie. Errors: `{ error: { code, message } }`. Rate limit default 60 req/min (expensive routes lower); 429 carries Retry-After.'
		},
		servers: [{ url: '/api/v1' }],
		components: {
			securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
			schemas: {
				Feed: {
					type: 'object',
					properties: {
						id: { type: 'integer' },
						url: { type: 'string' },
						title: { type: 'string' },
						siteUrl: { type: 'string', nullable: true },
						imageUrl: { type: 'string', nullable: true },
						collectionId: { type: 'integer', nullable: true },
						collectionName: { type: 'string' },
						unread: { type: 'integer' },
						total: { type: 'integer' }
					}
				},
				ArticleListItem: {
					type: 'object',
					description: 'Excerpt-only. Fetch one article for contentHtml.',
					properties: {
						id: { type: 'integer' },
						feedId: { type: 'integer' },
						feedTitle: { type: 'string' },
						title: { type: 'string' },
						link: { type: 'string' },
						author: { type: 'string', nullable: true },
						publishedAt: { type: 'string', format: 'date-time', nullable: true },
						excerpt: { type: 'string', nullable: true },
						imageUrl: { type: 'string', nullable: true },
						isRead: { type: 'boolean' },
						isSaved: { type: 'boolean' },
						tags: { type: 'array', items: { $ref: '#/components/schemas/TagRef' } }
					}
				},
				TagRef: {
					type: 'object',
					properties: { id: { type: 'integer' }, name: { type: 'string' } }
				},
				CursorPage: {
					type: 'object',
					description: '`cursor` is an offset; `nextCursor` null = exhausted.',
					properties: {
						nextCursor: { type: 'integer', nullable: true }
					}
				},
				Error: {
					type: 'object',
					properties: {
						error: {
							type: 'object',
							properties: { code: { type: 'string' }, message: { type: 'string' } }
						}
					}
				}
			}
		},
		paths: Object.assign(
			{},
			route('/health', { get: { summary: 'Liveness probe (public)', auth: 'none' } }),
			route('/feeds', {
				get: { summary: 'List feeds with unread/total counts', auth: 'read' },
				post: {
					summary: 'Add feed (202 provisioning, populated in background)',
					auth: 'write'
				}
			}),
			route('/feeds/{id}', {
				get: { summary: 'Get one feed', auth: 'read' },
				delete: { summary: 'Unsubscribe + delete feed', auth: 'write' }
			}),
			route('/feeds/{id}/move', {
				post: { summary: 'Move feed to a manual collection', auth: 'write' }
			}),
			route('/feeds/refresh', {
				get: { summary: 'Scheduler status', auth: 'read' },
				post: { summary: 'Refresh stale feeds (?force=1)', auth: 'write' }
			}),
			route('/articles', {
				get: {
					summary: 'List articles (excerpt-only, cursor offset)',
					auth: 'read',
					extra: {
						parameters: [
							{ name: 'filter', in: 'query', schema: { type: 'string', enum: ARTICLE_FILTERS } },
							{ name: 'feedId', in: 'query', schema: { type: 'integer' } },
							{ name: 'collectionId', in: 'query', schema: { type: 'integer' } },
							{ name: 'tagId', in: 'query', schema: { type: 'integer' } },
							{ name: 'viewId', in: 'query', schema: { type: 'integer' } },
							{ name: 'q', in: 'query', schema: { type: 'string' } },
							{ name: 'limit', in: 'query', schema: { type: 'integer', default: 30 } },
							{ name: 'cursor', in: 'query', schema: { type: 'integer', default: 0 } }
						]
					}
				}
			}),
			route('/articles/search', {
				get: { summary: 'Keyword article lookup (no embeddings)', auth: 'read' }
			}),
			route('/articles/{id}', {
				get: { summary: 'Get one article with contentHtml + tags', auth: 'read' },
				patch: { summary: 'Idempotent set { isRead?, isSaved? }', auth: 'write' }
			}),
			route('/articles/mark-read', {
				post: { summary: 'Bulk mark read: { ids[] } or { scope }', auth: 'write' }
			}),
			route('/articles/{id}/fulltext', {
				post: { summary: 'Scrape full text (?force=1 bypasses cooldown)', auth: 'write' }
			}),
			route('/articles/{id}/events', {
				post: { summary: 'Log behavior event { kind, value? }', auth: 'write' }
			}),
			route('/articles/{id}/feedback', {
				post: { summary: 'Explicit feedback { kind: dismiss|mute_feed|mute_topic }', auth: 'write' }
			}),
			route('/articles/{id}/tags', {
				get: { summary: 'List article tags', auth: 'read' },
				put: { summary: 'Replace tags { tags: string[]|string }', auth: 'write' }
			}),
			route('/collections', {
				get: { summary: 'List collections + smart views', auth: 'read' },
				post: { summary: 'Create { name, kind?, rules? }', auth: 'write' }
			}),
			route('/collections/{id}', {
				patch: { summary: 'Rename / update smart rules', auth: 'write' },
				delete: { summary: 'Delete (feeds fall back to General)', auth: 'write' }
			}),
			route('/tags', { get: { summary: 'List tags with counts', auth: 'read' } }),
			route('/tags/{id}', {
				patch: { summary: 'Rename tag', auth: 'write' },
				delete: { summary: 'Delete tag', auth: 'write' }
			}),
			route('/discover/search', {
				get: { summary: 'Publisher/route discovery (?q, limit, sort)', auth: 'read' }
			}),
			route('/discover/follow', {
				post: { summary: 'Follow { url } or { routePath, prefill? }', auth: 'write' }
			}),
			route('/opml', {
				get: { summary: 'Export OPML (XML download)', auth: 'read' },
				post: { summary: 'Import OPML (multipart file or raw XML)', auth: 'write' }
			}),
			route('/settings', {
				get: { summary: 'Get resolved settings', auth: 'read' },
				patch: { summary: 'Update { settings: { key: value } }', auth: 'write' }
			})
		)
	};
	return send(request, json(spec, { headers: { 'Cache-Control': 'public, max-age=300' } }));
};
