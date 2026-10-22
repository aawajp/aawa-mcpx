import type { ClientInfo } from '@/shared/client_info';
import type { ClientActivity } from '@/shared/ui_api';

// The user is kept by ID, so the list shows its current label.
type ClientEntry = Omit<ClientActivity, 'user'>;

const createClientActivityTracker = (limit: number) => {
	const clients = new Map<string, ClientEntry>();
	const observe = (
		reported: ClientInfo | undefined,
		protocolVersion: string,
		userId?: string,
	): void => {
		// MCP 2026-07-28 allows the whole clientInfo object to be omitted.
		const client = reported ?? {
			name: 'unknown',
			version: 'unknown',
		};
		// One entry per application (reported name/version), user and protocol.
		const key = JSON.stringify([
			client.name,
			client.version,
			userId,
			protocolVersion,
		]);
		const previous = clients.get(key);
		const now = Date.now();
		clients.delete(key);
		clients.set(key, {
			client,
			userId,
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
		// Newest first; a user missing from `userLabels` (deleted) shows its ID.
		list: (userLabels?: Map<string, string>): ClientActivity[] =>
			Array.from(clients.values())
				.reverse()
				.map(({ userId, ...entry }) =>
					userId === undefined
						? entry
						: {
								...entry,
								user: userLabels?.get(userId) ?? userId,
								userId,
							},
				),
	};
};

export { createClientActivityTracker };
