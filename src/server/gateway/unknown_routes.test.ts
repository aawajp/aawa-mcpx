import {
	createUnknownRouteHandler,
	withTrailingSlashes,
} from '@/server/gateway/unknown_routes';

import { expect, test } from 'bun:test';

const handler = () => new Response();

test('routes answer with and without a trailing slash', () => {
	const routes = withTrailingSlashes({
		'/': handler,
		'/mcp': {
			POST: handler,
		},
	});
	expect(Object.keys(routes)).toEqual(['/', '/mcp', '/mcp/']);
	expect(routes['/mcp/']).toBe(routes['/mcp']);
});

test('a known path with another method gets 405 and any other path 404', async () => {
	const unknown = createUnknownRouteHandler(
		withTrailingSlashes({
			'/mcp': {
				POST: handler,
				DELETE: handler,
			},
			'/api/overview': {
				GET: handler,
			},
		}),
	);
	const answer = async (method: string, path: string) => {
		const response = unknown(
			new Request(`http://localhost${path}`, {
				method,
			}),
		);
		return [
			response.status,
			response.headers.get('Allow'),
			await response.json(),
		];
	};
	for (const path of ['/mcp', '/mcp/'])
		for (const method of ['GET', 'PUT', 'PATCH', 'OPTIONS'])
			expect(await answer(method, path)).toEqual([
				405,
				'POST, DELETE',
				{
					error: `Method ${method} is not allowed on ${path}`,
				},
			]);
	expect(await answer('POST', '/api/overview')).toEqual([
		405,
		'GET, HEAD',
		{
			error: 'Method POST is not allowed on /api/overview',
		},
	]);
	for (const path of [
		'/nope',
		'/api',
		'/api/',
		'/api/nope',
		'/mcp/x',
		'/mcp//',
	])
		expect(await answer('POST', path)).toEqual([
			404,
			null,
			{
				error: `Unknown route: ${path}`,
			},
		]);
});
