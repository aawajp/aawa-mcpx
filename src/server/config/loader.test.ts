import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	load,
	saveBackendEnabled,
	saveToolState,
} from '@/server/config/loader';

import { expect, test } from 'bun:test';

test('saving changes only gateway-owned fields and skips unchanged state', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'mcpx-loader-'));
	const configPath = path.join(root, 'mcp.json');
	try {
		const backend = {
			type: 'stdio',
			command: 'backend',
		};
		await writeFile(
			configPath,
			JSON.stringify({
				mcpServers: {
					backend,
				},
			}),
		);
		const config = await load(configPath);
		const toolState = {
			configPath,
			config,
			serverName: 'backend',
			enabledTools: ['a'],
			availableTools: ['a', 'b'],
		};
		await saveToolState(toolState);
		// Defaults filled in at load (timeout, enabled, trafficLimit) stay out.
		expect(await Bun.file(configPath).json()).toEqual({
			mcpServers: {
				backend: {
					...backend,
					enabledTools: ['a'],
					availableTools: ['a', 'b'],
				},
			},
		});
		await writeFile(configPath, 'unchanged');
		await saveToolState(toolState);
		expect(await Bun.file(configPath).text()).toBe('unchanged');
		await saveBackendEnabled({
			configPath,
			config,
			serverName: 'backend',
			enabled: false,
		});
		expect(await Bun.file(configPath).json()).toEqual({
			mcpServers: {
				backend: {
					...backend,
					enabledTools: ['a'],
					availableTools: ['a', 'b'],
					enabled: false,
				},
			},
		});
	} finally {
		await rm(root, {
			recursive: true,
			force: true,
		});
	}
});
