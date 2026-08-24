import { type } from 'arktype';

import { randomUUID } from 'node:crypto';

import {
	getRecord,
	type IncomingJsonRpcNotification,
	type IncomingJsonRpcRequest,
	type RouteResult,
} from '@/gateway/json_rpc';
import { logger } from '@/server/logger';

type ClientInfo = {
	name?: string;
	title?: string;
	version?: string;
};

type SessionStatus = 'connected' | 'disconnected' | 'expired';

type SessionInfo = {
	client: ClientInfo;
	protocolVersion?: string;
	status: SessionStatus;
	createdAt: number;
	lastSeen: number;
	disconnectedAt?: number;
	lastStatus?: string;
};

type ClientSession = SessionInfo & {
	sessionId: string;
};

type CloseSessionResult = {
	reason?: 'inactive-session' | 'missing-session' | 'unknown-session';
	status: 202 | 400 | 404;
};

type CreateMcpSessionManagerParams = {
	historyLimit: number;
	protocolHeaderName: string;
	sessionTtlMs: number;
	sweepIntervalMs: number;
	supportedProtocolVersions: readonly string[];
};

const clientInfoType = type({
	'name?': 'string',
	'title?': 'string',
	'version?': 'string',
	'[string]': 'unknown',
});

const gatewayProtocolVersionType = type(
	"'2025-11-25' | '2025-06-18' | '2025-03-26'",
);

const getString = (value: unknown): string | undefined => {
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
};

const createProtocolError = (params: {
	id?: string | number;
	message: string;
	status?: number;
}): RouteResult => {
	return {
		payload: {
			jsonrpc: '2.0',
			id: params.id,
			error: {
				code: params.status ?? 400,
				message: params.message,
			},
		},
		status: params.status ?? 400,
	};
};

const createMcpSessionManager = (params: CreateMcpSessionManagerParams) => {
	const sessions = new Map<string, SessionInfo>();
	let sessionSweepTimer: Timer | null = null;

	const activeCount = (): number => {
		let count = 0;
		for (const session of sessions.values()) {
			if (session.status === 'connected') {
				count++;
			}
		}
		return count;
	};

	const pruneHistory = (): void => {
		if (sessions.size <= params.historyLimit) return;
		const inactive = Array.from(sessions.entries())
			.filter(([, session]) => session.status !== 'connected')
			.sort((a, b) => a[1].lastSeen - b[1].lastSeen);
		while (sessions.size > params.historyLimit && inactive.length > 0) {
			const next = inactive.shift();
			if (next) {
				sessions.delete(next[0]);
			}
		}
	};

	const touch = (sessionId: string): void => {
		const session = sessions.get(sessionId);
		if (!session) return;
		if (session.status !== 'connected') return;
		session.lastSeen = Date.now();
	};

	const sweepExpired = (): number => {
		const now = Date.now();
		let expired = 0;
		for (const [sessionId, session] of sessions.entries()) {
			if (
				session.status === 'connected' &&
				now - session.lastSeen > params.sessionTtlMs
			) {
				const idleMs = now - session.lastSeen;
				const durationMs = now - session.createdAt;
				session.status = 'expired';
				session.disconnectedAt = now;
				session.lastStatus = 'Session expired';
				expired++;
				logger.info(
					`MCP session ended: ${formatSessionLifecycleFields({
						sessionId,
						trigger: 'session-sweeper',
						reason: 'idle-timeout',
						durationMs,
						idleMs,
					})}`,
				);
			}
		}
		if (expired > 0) {
			pruneHistory();
		}
		return expired;
	};

	const startSweeper = (): void => {
		if (sessionSweepTimer) return;
		sessionSweepTimer = setInterval(() => {
			const removed = sweepExpired();
			if (removed > 0) {
				logger.info(
					`MCP session sweep completed: trigger=session-sweeper, reason=idle-timeout, expired=${removed}, active=${activeCount()}`,
				);
			}
		}, params.sweepIntervalMs);
	};

	const stopSweeper = (): void => {
		if (!sessionSweepTimer) return;
		clearInterval(sessionSweepTimer);
		sessionSweepTimer = null;
	};

	const getClientInfo = (value: unknown): ClientInfo | undefined => {
		const record = getRecord(value);
		if (!clientInfoType.allows(record?.clientInfo)) return undefined;
		const clientInfo = record.clientInfo;
		return {
			name: getString(clientInfo.name),
			title: getString(clientInfo.title),
			version: getString(clientInfo.version),
		};
	};

	const formatClientInfo = (client: ClientInfo): string => {
		const name = client.name ?? 'missing-client-info';
		const version = client.version;
		return version ? `${name}@${version}` : name;
	};

	const formatClient = (
		sessionId: string | undefined,
		requestParams?: unknown,
	): string => {
		const requestClient = getClientInfo(requestParams);
		if (requestClient) return formatClientInfo(requestClient);
		if (!sessionId) return 'no-session';
		const session = sessions.get(sessionId);
		if (!session) return 'unknown-session';
		return formatClientInfo(session.client);
	};

	const formatSessionLifecycleFields = (fields: {
		sessionId: string;
		trigger: 'client-delete' | 'request-validation' | 'session-sweeper';
		reason: 'client-requested' | 'idle-timeout' | 'inactive-session';
		method?: string;
		status?: SessionStatus;
		durationMs?: number;
		idleMs?: number;
	}): string => {
		let message = `client=${formatClient(fields.sessionId)}, session=${fields.sessionId}`;
		if (fields.method) {
			message += `, method=${fields.method}`;
		}
		message += `, trigger=${fields.trigger}, reason=${fields.reason}`;
		if (fields.status) {
			message += `, status=${fields.status}`;
		}
		if (typeof fields.durationMs === 'number') {
			message += `, durationMs=${fields.durationMs}`;
		}
		if (typeof fields.idleMs === 'number') {
			message += `, idleMs=${fields.idleMs}`;
		}
		message += `, active=${activeCount()}`;
		return message;
	};

	const logStateMismatch = (mismatch: {
		method: string;
		sessionId: string | undefined;
		reason?: 'expired-session' | 'inactive-session';
	}): void => {
		if (!mismatch.sessionId) {
			logger.warn(
				`Session mismatch: session=none, method=${mismatch.method}, reason=missing-session, active=${activeCount()}`,
			);
			return;
		}
		const session = sessions.get(mismatch.sessionId);
		if (!session) {
			logger.warn(
				`Session mismatch: session=${mismatch.sessionId}, method=${mismatch.method}, reason=unknown-session, active=${activeCount()}`,
			);
			return;
		}
		if (mismatch.reason === 'expired-session') {
			logger.warn(
				`Session mismatch: session=${mismatch.sessionId}, method=${mismatch.method}, reason=expired-session, status=${session.status}, active=${activeCount()}`,
			);
			return;
		}
		if (
			session.status !== 'connected' ||
			mismatch.reason === 'inactive-session'
		) {
			logger.warn(
				`Session mismatch: session=${mismatch.sessionId}, method=${mismatch.method}, reason=inactive-session, status=${session.status}, active=${activeCount()}`,
			);
		}
	};

	const countActiveForClient = (client: ClientInfo): number => {
		let count = 0;
		for (const session of sessions.values()) {
			if (session.status !== 'connected') continue;
			if (session.client.name !== client.name) continue;
			if (session.client.version !== client.version) continue;
			count++;
		}
		return count;
	};

	const getInitializeParams = (
		request: IncomingJsonRpcRequest,
	): {
		client: ClientInfo;
		protocolVersion?: string;
	} => {
		const requestParams = getRecord(request.params);
		const client = getClientInfo(request.params) ?? {};
		return {
			client,
			protocolVersion: getString(requestParams?.protocolVersion),
		};
	};

	const negotiateProtocolVersion = (
		requested: string | undefined,
	): string | null => {
		if (gatewayProtocolVersionType.allows(requested)) return requested;
		return null;
	};

	const handleInitialize = async (
		request: IncomingJsonRpcRequest,
		incomingSessionId: string | undefined,
	): Promise<RouteResult> => {
		if (incomingSessionId) {
			return createProtocolError({
				id: request.id,
				message: 'Initialize request must not include MCP session ID.',
			});
		}
		const requested = getInitializeParams(request);
		const protocolVersion = negotiateProtocolVersion(requested.protocolVersion);
		if (!protocolVersion) {
			return {
				payload: {
					jsonrpc: '2.0',
					id: request.id,
					error: {
						code: -32000,
						message: `Unsupported MCP protocol version: ${requested.protocolVersion ?? 'missing'}`,
						data: {
							supported: params.supportedProtocolVersions,
						},
					},
				},
				status: 400,
			};
		}
		const sessionId = randomUUID();
		const now = Date.now();
		const sameClientActive = countActiveForClient(requested.client);
		sessions.set(sessionId, {
			client: requested.client,
			protocolVersion,
			status: 'connected',
			createdAt: now,
			lastSeen: now,
			lastStatus: 'Connected',
		});
		pruneHistory();
		const clientLabel = formatClient(sessionId);
		const title = requested.client.title
			? `, title=${requested.client.title}`
			: '';
		const protocol = protocolVersion ? `, mcpProtocol=${protocolVersion}` : '';
		const requestedProtocol =
			requested.protocolVersion && requested.protocolVersion !== protocolVersion
				? `, requestedMcpProtocol=${requested.protocolVersion}`
				: '';
		const duplicate =
			sameClientActive > 0 ? `, sameClientActive=${sameClientActive}` : '';
		const incoming = incomingSessionId
			? `, incomingSession=${incomingSessionId}`
			: '';
		logger.info(
			`New MCP session: client=${clientLabel}${title}${protocol}${requestedProtocol}, session=${sessionId}${duplicate}${incoming}, active=${activeCount()}`,
		);

		return {
			sessionId,
			payload: {
				jsonrpc: '2.0',
				id: request.id,
				result: {
					protocolVersion,
					serverInfo: {
						name: 'aawa-mcpx',
						version: '1.0.0',
					},
					capabilities: {
						tools: {},
						prompts: {},
						resources: {},
					},
				},
			},
		};
	};

	const requireSession = (
		sessionId: string | undefined,
		id: string | number | undefined,
		method: string,
	): RouteResult | null => {
		if (!sessionId) {
			logStateMismatch({
				method,
				sessionId,
			});
			return createProtocolError({
				id,
				message: 'Missing MCP session',
			});
		}
		const session = sessions.get(sessionId);
		if (!session) {
			logStateMismatch({
				method,
				sessionId,
			});
			return createProtocolError({
				id,
				message:
					'Unknown MCP session. Please re-initialize by calling initialize.',
				status: 404,
			});
		}
		if (
			session.status !== 'connected' ||
			Date.now() - session.lastSeen > params.sessionTtlMs
		) {
			const now = Date.now();
			const idleMs = now - session.lastSeen;
			const durationMs = now - session.createdAt;
			if (session.status === 'connected') {
				session.status = 'expired';
				session.disconnectedAt = now;
				session.lastStatus = 'Session expired';
				logger.info(
					`MCP session ended: ${formatSessionLifecycleFields({
						sessionId,
						method,
						trigger: 'request-validation',
						reason: 'idle-timeout',
						durationMs,
						idleMs,
					})}`,
				);
			}
			logStateMismatch({
				method,
				sessionId,
				reason: session.status === 'expired' ? 'expired-session' : undefined,
			});
			return createProtocolError({
				id,
				message: 'Session expired. Please re-initialize by calling initialize.',
				status: 404,
			});
		}
		touch(sessionId);
		return null;
	};

	const validateProtocolHeader = (
		request: Request,
		sessionId: string | undefined,
		id: string | number | undefined,
		method: string,
	): RouteResult | null => {
		if (method === 'initialize') return null;
		const header = request.headers.get(params.protocolHeaderName);
		if (!header) return null;
		if (!gatewayProtocolVersionType.allows(header)) {
			return createProtocolError({
				id,
				message: `Unsupported MCP protocol version header: ${header}`,
			});
		}
		const session = sessionId ? sessions.get(sessionId) : undefined;
		if (session?.protocolVersion && session.protocolVersion !== header) {
			return createProtocolError({
				id,
				message: `MCP protocol version header mismatch: expected ${session.protocolVersion}, received ${header}`,
			});
		}
		return null;
	};

	const routeNotification = (
		notification: IncomingJsonRpcNotification,
		sessionId: string | undefined,
	): RouteResult => {
		const invalid = requireSession(sessionId, undefined, notification.method);
		if (invalid) return invalid;
		return {
			payload: null,
			sessionId,
		};
	};

	const routeResponse = (sessionId: string | undefined): RouteResult => {
		const invalid = requireSession(sessionId, undefined, 'response');
		if (invalid) return invalid;
		return {
			payload: null,
			sessionId,
		};
	};

	const close = (sessionId: string | undefined): CloseSessionResult => {
		const session = sessionId ? sessions.get(sessionId) : undefined;
		if (!sessionId) {
			logger.warn(
				`MCP session close rejected: reason=missing-session, active=${activeCount()}`,
			);
			return {
				reason: 'missing-session',
				status: 400,
			};
		}
		if (!session) {
			logger.warn(
				`MCP session close rejected: reason=unknown-session, session=${sessionId}, active=${activeCount()}`,
			);
			return {
				reason: 'unknown-session',
				status: 404,
			};
		}
		if (session.status !== 'connected') {
			logger.warn(
				`MCP session close ignored: ${formatSessionLifecycleFields({
					sessionId,
					trigger: 'client-delete',
					reason: 'inactive-session',
					status: session.status,
				})}`,
			);
			return {
				reason: 'inactive-session',
				status: 404,
			};
		}
		const durationMs = Date.now() - session.createdAt;
		session.status = 'disconnected';
		session.disconnectedAt = Date.now();
		session.lastSeen = session.disconnectedAt;
		session.lastStatus = 'Client disconnected';
		pruneHistory();
		logger.info(
			`MCP session ended: ${formatSessionLifecycleFields({
				sessionId,
				trigger: 'client-delete',
				reason: 'client-requested',
				durationMs,
			})}`,
		);
		return {
			status: 202,
		};
	};

	const list = (): ClientSession[] => {
		return Array.from(sessions.entries())
			.map(([sessionId, session]) => ({
				sessionId,
				...session,
			}))
			.sort((a, b) => b.lastSeen - a.lastSeen);
	};

	return {
		activeCount,
		clear: () => sessions.clear(),
		close,
		formatClient,
		handleInitialize,
		list,
		requireSession,
		routeNotification,
		routeResponse,
		startSweeper,
		stopSweeper,
		validateProtocolHeader,
	};
};

export type {
	ClientInfo,
	ClientSession,
	CloseSessionResult,
	SessionInfo,
	SessionStatus,
};
export { createMcpSessionManager };
