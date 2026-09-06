import type { ClientInfo } from '@/shared/client_info';
import type { ClientActivity } from '@/shared/ui_api';

const createClientActivityTracker = (limit: number) => {
	const clients = new Map<string, ClientActivity>();
	const observe = (
		reported: ClientInfo | undefined,
		protocolVersion: string,
	): void => {
		// MCP 2026-07-28 allows the whole clientInfo object to be omitted.
		const client = reported ?? {
			name: 'unknown',
			version: 'unknown',
		};
		// Identify an application by its reported name/version.
		const key = JSON.stringify([
			client.name,
			client.version,
		]);
		const previous = clients.get(key);
		const now = Date.now();
		clients.delete(key);
		clients.set(key, {
			client,
			protocolVersion,
			firstSeen: previous?.firstSeen ?? now,
			lastSeen: now,
		});
		if (clients.size > limit) {
			const oldest = clients.keys().next().value;
			if (oldest !== undefined) clients.delete(oldest);
		}
	};
	return {
		observe,
		list: (): ClientActivity[] => Array.from(clients.values()).reverse(),
	};
};

export { createClientActivityTracker };
