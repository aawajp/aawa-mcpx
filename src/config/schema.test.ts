import { mcpConfigType } from '@/config/schema';

import { expect, test } from 'bun:test';

test('backend enabled setting defaults to true', () => {
	const defaultConfig = mcpConfigType.assert({
		mcpServers: {
			mock: {
				type: 'http',
				url: 'http://127.0.0.1:3000/mcp',
			},
		},
	});
	expect(defaultConfig.mcpServers.mock?.enabled).toBe(true);

	const disabledConfig = mcpConfigType.assert({
		mcpServers: {
			mock: {
				type: 'http',
				url: 'http://127.0.0.1:3000/mcp',
				enabled: false,
			},
		},
	});
	expect(disabledConfig.mcpServers.mock?.enabled).toBe(false);
});
