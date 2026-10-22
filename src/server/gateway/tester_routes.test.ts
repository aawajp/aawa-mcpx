import { createTesterRoutes } from '@/server/gateway/tester_routes';
import { TESTER_PATH, testerResponseType } from '@/shared/ui_api';

import { expect, mock, test } from 'bun:test';

test('the Tester sends the request to /mcp signed as the admin and returns both sides', async () => {
	let received: Request | undefined;
	const routes = createTesterRoutes({
		mcpRoute: {
			POST: async (request) => {
				received = request;
				return Response.json(
					{
						jsonrpc: '2.0',
						id: 1,
						result: {},
					},
					{
						status: 200,
						headers: {
							'X-Test': 'yes',
						},
					},
				);
			},
		},
		auth: {
			ui: {
				superadminIdOf: () => undefined,
				accessToken: async () => 'admin-token',
			},
			mcp: {
				signTesterRequest: () => undefined,
			},
		},
	});
	const body = {
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/list',
	};
	const response = await routes[TESTER_PATH].POST(
		new Request(`http://localhost:4567${TESTER_PATH}`, {
			method: 'POST',
			body: JSON.stringify({
				headers: {
					'Mcp-Method': 'tools/list',
				},
				body,
			}),
		}),
	);
	const exchange = testerResponseType.assert(await response.json());
	expect(received?.url).toBe('http://localhost:4567/mcp');
	expect(received?.headers.get('authorization')).toBe('Bearer admin-token');
	expect(await received?.json()).toEqual(body);
	expect(exchange.request).toMatchObject({
		url: 'http://localhost:4567/mcp',
		headers: {
			authorization: 'Bearer admin-token',
			'mcp-method': 'tools/list',
		},
		body,
	});
	expect(exchange.response).toMatchObject({
		status: 200,
		headers: {
			'x-test': 'yes',
		},
		body: {
			result: {},
		},
	});
});

test('the Tester signs as the superadmin without asking for an access token', async () => {
	const received: Request[] = [];
	const signed: string[] = [];
	const accessToken = mock(async () => 'oidc-token');
	const superadmin = {
		current: undefined as string | undefined,
	};
	const routes = createTesterRoutes({
		mcpRoute: {
			POST: async (request) => {
				received.push(request);
				return Response.json({});
			},
		},
		auth: {
			ui: {
				superadminIdOf: () => superadmin.current,
				accessToken,
			},
			mcp: {
				signTesterRequest: (_request, userId) => {
					signed.push(userId);
				},
			},
		},
	});
	const send = () =>
		routes[TESTER_PATH].POST(
			new Request(`http://localhost${TESTER_PATH}`, {
				method: 'POST',
				body: JSON.stringify({
					headers: {},
					body: {},
				}),
			}),
		);
	// An OIDC admin's request carries the admin's access token.
	await send();
	expect(received[0]?.headers.get('authorization')).toBe('Bearer oidc-token');
	expect(signed).toEqual([]);
	superadmin.current = 'superadmin-id';
	await send();
	expect(received[1]?.headers.get('authorization')).toBeNull();
	expect(signed).toEqual(['superadmin-id']);
	expect(accessToken).toHaveBeenCalledTimes(1);
});
