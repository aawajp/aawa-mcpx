import { randomUUID } from 'node:crypto';

import {
	getRecord,
	type IncomingJsonRpcNotification,
	type IncomingJsonRpcRequest,
	type RouteResult,
} from '@/gateway/json_rpc';
import { logger } from '@/server/logger';
import { type ClientInfo, parseClientInfo } from '@/shared/client_info';
import {
	isProtocolVersion,
	type ProtocolVersion,
	requiresInitialization,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@/shared/mcp_protocol';

type SessionInfo = {
	client: ClientInfo;
	protocolVersion: string;
};

type CloseSessionResult = {
	reason?: 'missing-session' | 'unknown-session';
	status: 202 | 400 | 404;
};

type CreateMcpSessionManagerParams = {
	maxSessionsPerClient?: number;
	onClientActivity?: (client: ClientInfo, protocolVersion: string) => void;
	protocolHeaderName: string;
	supportedProtocolVersions: readonly string[];
};

const isSupportedSessionVersion = (
	version: unknown,
): version is ProtocolVersion =>
	isProtocolVersion(version) && requiresInitialization(version);

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
	// 2025-06-18 and 2025-11-25 requests use the issued ID to recover their
	// negotiated version and client identity. It is transport state, not a client ID.
	const sessions = new Map<string, SessionInfo>();
	const limit = params.maxSessionsPerClient ?? 10;
	if (!Number.isSafeInteger(limit) || limit < 1)
		throw new Error('Session limit must be a positive integer');
	const activeCount = (): number => sessions.size;

	const getClientInfo = (value: unknown): ClientInfo | undefined => {
		const record = getRecord(value);
		return parseClientInfo(record?.clientInfo);
	};

	const formatClientInfo = (client: ClientInfo): string => {
		const name = client.name;
		const version = client.version;
		return version ? `${name}@${version}` : name;
	};

	const formatClient = (
		sessionId: string | undefined,
		requestParams?: unknown,
	): string => {
		const requestClient = getClientInfo(requestParams);
		if (requestClient) return formatClientInfo(requestClient);
		if (!sessionId) return 'unknown';
		const session = sessions.get(sessionId);
		if (!session) return 'unknown';
		return formatClientInfo(session.client);
	};

	const getInitializeParams = (
		request: IncomingJsonRpcRequest,
	): {
		client: ClientInfo | undefined;
		protocolVersion?: string;
	} => {
		const requestParams = getRecord(request.params);
		const client = getClientInfo(request.params);
		return {
			client,
			protocolVersion: getString(requestParams?.protocolVersion),
		};
	};

	const negotiateProtocolVersion = (
		requested: string | undefined,
	): string | null => {
		if (isSupportedSessionVersion(requested)) return requested;
		return requested
			? (SUPPORTED_PROTOCOL_VERSIONS.find(requiresInitialization) ?? null)
			: null;
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
		if (!requested.client)
			return {
				status: 400,
				payload: {
					jsonrpc: '2.0',
					id: request.id,
					error: {
						code: -32602,
						message: 'Client info must include string name and version fields.',
					},
				},
			};
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
		const client = requested.client;
		// Local retention policy, not a protocol identity guarantee: multiple agents
		// may share name/version. Map insertion order keeps the oldest initialization
		// first; activity does not reorder it. Only this client's excess session is removed.
		const clientSessions = Array.from(sessions).filter(
			([, session]) =>
				session.client.name === client.name &&
				session.client.version === client.version,
		);
		if (clientSessions.length >= limit) {
			const oldest = clientSessions[0];
			if (oldest) sessions.delete(oldest[0]);
		}
		sessions.set(sessionId, {
			client: requested.client,
			protocolVersion,
		});
		params.onClientActivity?.(requested.client, protocolVersion);
		const clientLabel = formatClientInfo(requested.client);
		const title = requested.client.title
			? `, title=${requested.client.title}`
			: '';
		const protocol = protocolVersion ? `, mcpProtocol=${protocolVersion}` : '';
		const requestedProtocol =
			requested.protocolVersion && requested.protocolVersion !== protocolVersion
				? `, requestedMcpProtocol=${requested.protocolVersion}`
				: '';
		logger.info(
			`New MCP session: client=${clientLabel}${title}${protocol}${requestedProtocol}, active=${activeCount()}`,
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
		_method: string,
	): RouteResult | null => {
		if (!sessionId) {
			return createProtocolError({
				id,
				message: 'Missing MCP session',
			});
		}
		const session = sessions.get(sessionId);
		if (!session) {
			return createProtocolError({
				id,
				message:
					'Unknown MCP session. Please re-initialize by calling initialize.',
				status: 404,
			});
		}
		params.onClientActivity?.(session.client, session.protocolVersion);
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
		if (!isSupportedSessionVersion(header)) {
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
				`MCP session close rejected: reason=unknown-session, active=${activeCount()}`,
			);
			return {
				reason: 'unknown-session',
				status: 404,
			};
		}
		sessions.delete(sessionId);
		logger.info(
			`MCP session ended: client=${formatClientInfo(session.client)}, reason=client-requested, active=${activeCount()}`,
		);
		return {
			status: 202,
		};
	};

	return {
		activeCount,
		clear: () => sessions.clear(),
		close,
		formatClient,
		getClient: (sessionId: string | undefined): ClientInfo | undefined =>
			sessionId ? sessions.get(sessionId)?.client : undefined,
		getProtocolVersion: (sessionId: string | undefined): string | undefined =>
			sessionId ? sessions.get(sessionId)?.protocolVersion : undefined,
		handleInitialize,
		requireSession,
		routeNotification,
		routeResponse,
		validateProtocolHeader,
	};
};

export type { ClientInfo } from '@/shared/client_info';

export type { CloseSessionResult, SessionInfo };
export { createMcpSessionManager };
