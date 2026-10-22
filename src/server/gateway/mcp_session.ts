import { randomUUID } from 'node:crypto';

import {
	type IncomingJsonRpcRequest,
	type RouteResult,
	rpcError,
	type SessionError,
} from '@/server/gateway/json_rpc';
import { logger } from '@/server/logger';
import {
	CLIENT_INFO_BYTES,
	CLIENT_NAME_LENGTH,
	type ClientInfo,
	formatClientInfo,
	parseClientInfo,
} from '@/shared/client_info';
import {
	GATEWAY_CAPABILITIES,
	GATEWAY_INFO,
	isProtocolVersion,
	JSONRPC_VERSION,
	MCP_HEADERS,
	type ProtocolVersion,
	RPC_ERROR,
	recordOf,
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
	maxSessionsPerClient: number;
	onClientActivity?: (client: ClientInfo, protocolVersion: string) => void;
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
}): SessionError => {
	return {
		payload: rpcError(params.id, RPC_ERROR.InvalidRequest, params.message),
		status: params.status ?? 400,
	};
};

const createMcpSessionManager = (params: CreateMcpSessionManagerParams) => {
	// 2025-06-18 and 2025-11-25 requests use the issued ID to recover their
	// negotiated version and client identity. It is transport state, not a client ID.
	const sessions = new Map<string, SessionInfo>();
	const limit = params.maxSessionsPerClient;
	const activeCount = (): number => sessions.size;

	const getClientInfo = (value: unknown): ClientInfo | undefined => {
		const record = recordOf(value);
		return parseClientInfo(record?.clientInfo);
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
		const requestParams = recordOf(request.params);
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
				payload: rpcError(
					request.id,
					RPC_ERROR.InvalidParams,
					`Client info must include string name and version fields of at most ${CLIENT_NAME_LENGTH} characters, and be at most ${CLIENT_INFO_BYTES} bytes as JSON.`,
				),
			};
		const protocolVersion = negotiateProtocolVersion(requested.protocolVersion);
		if (!protocolVersion) {
			return {
				payload: rpcError(
					request.id,
					RPC_ERROR.InvalidParams,
					`Unsupported MCP protocol version: ${requested.protocolVersion ?? 'missing'}`,
					{
						supported: SUPPORTED_PROTOCOL_VERSIONS,
					},
				),
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
				jsonrpc: JSONRPC_VERSION,
				id: request.id,
				result: {
					protocolVersion,
					serverInfo: GATEWAY_INFO,
					capabilities: GATEWAY_CAPABILITIES,
				},
			},
		};
	};

	const requireSession = (
		sessionId: string | undefined,
		id: string | number | undefined,
	): SessionError | null => {
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
	): SessionError | null => {
		if (method === 'initialize') return null;
		const header = request.headers.get(MCP_HEADERS.ProtocolVersion);
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
		validateProtocolHeader,
	};
};

export { createMcpSessionManager };
