import { createHostCheck, guardRoutes } from '@/server/gateway/allowed_hosts';
import { createMcpForbiddenResponse } from '@/server/gateway/mcp_http_route';
import { createApiForbiddenResponse } from '@/server/gateway/ui_routes';

import { expect, test } from 'bun:test';

const request = (url: string, origin?: string) =>
	new Request(url, {
		method: 'POST',
		headers: origin === undefined ? {} : { Origin: origin },
	});

test('host and Origin must be listed in ALLOWED_HOSTS', () => {
	const isAllowed = createHostCheck([
		'localhost',
		'127.0.0.1',
		'[::1]',
		'mcpx.lan',
		'[fd00::1]',
	]);
	for (const [url, origin] of [
		['http://localhost:4567/mcp'],
		['http://127.0.0.1/mcp', 'http://localhost:3000'],
		['http://[::1]:4567/api/overview', 'http://[::1]:4567'],
		['http://MCPX.lan:4567/mcp', 'https://mcpx.lan'],
		['http://[fd00::1]/mcp'],
	] as const)
		expect(isAllowed(request(url, origin))).toBe(true);
	for (const [url, origin] of [
		// A rebinding page names its own host in both Host and Origin.
		['http://evil.example:4567/mcp', 'http://evil.example:4567'],
		['http://evil.example/mcp'],
		['http://localhost:4567/mcp', 'http://evil.example'],
		['http://localhost:4567/mcp', 'null'],
		['http://mcpx.lan.evil.example/mcp'],
		['http://192.168.1.10/mcp'],
	] as const)
		expect(isAllowed(request(url, origin))).toBe(false);
	expect(createHostCheck(['mcpx.lan'])(request('http://localhost/mcp'))).toBe(
		false,
	);
});

test('guarded routes answer a refused host with 403 before the handler runs', async () => {
	let calls = 0;
	const handler = (request: Request) => {
		calls += 1;
		return new Response(request.method);
	};
	const isAllowed = createHostCheck(['localhost']);
	const mcp = guardRoutes(
		{ '/mcp': { POST: handler } },
		isAllowed,
		createMcpForbiddenResponse,
	);
	const api = guardRoutes(
		{ '/api/overview': { GET: handler } },
		isAllowed,
		createApiForbiddenResponse,
	);
	const refusedMcp = await mcp['/mcp'].POST(request('http://evil.example/mcp'));
	expect(refusedMcp.status).toBe(403);
	expect(await refusedMcp.json()).toEqual({
		jsonrpc: '2.0',
		error: {
			code: -32600,
			message: 'Host or Origin is not allowed.',
		},
	});
	const refusedApi = await api['/api/overview'].GET(
		request('http://localhost/api/overview', 'http://evil.example'),
	);
	expect(refusedApi.status).toBe(403);
	expect(await refusedApi.json()).toEqual({
		error: 'Host or Origin is not allowed.',
	});
	expect(calls).toBe(0);
	expect(
		await (await mcp['/mcp'].POST(request('http://localhost/mcp'))).text(),
	).toBe('POST');
	expect(calls).toBe(1);
});
