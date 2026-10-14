import type {
	JSONRPCErrorResponse,
	JSONRPCResultResponse,
} from '@modelcontextprotocol/client';

import { JSONRPC_VERSION, recordOf } from '@/shared/mcp_protocol';
import { jsonRpcResponseType } from '@/shared/mcp_schemas';

type IncomingJsonRpcRequest = {
	jsonrpc: typeof JSONRPC_VERSION;
	method: string;
	id: string | number;
	params?: unknown;
	result?: never;
	error?: never;
};

type IncomingJsonRpcNotification = {
	jsonrpc: typeof JSONRPC_VERSION;
	method: string;
	id?: never;
	params?: unknown;
	result?: never;
	error?: never;
};

type IncomingJsonRpcResultResponse = {
	jsonrpc: typeof JSONRPC_VERSION;
	method?: never;
	id: string | number;
	params?: never;
	result: unknown;
	error?: never;
};

type IncomingJsonRpcErrorResponse = {
	jsonrpc: typeof JSONRPC_VERSION;
	method?: never;
	id?: string | number;
	params?: never;
	result?: never;
	error: {
		code: number;
		message: string;
		data?: unknown;
	};
};

type IncomingJsonRpcResponse =
	| IncomingJsonRpcResultResponse
	| IncomingJsonRpcErrorResponse;

type IncomingJsonRpcMessage =
	| IncomingJsonRpcRequest
	| IncomingJsonRpcNotification
	| IncomingJsonRpcResponse;

type OutgoingJsonRpcResponse = JSONRPCResultResponse | JSONRPCErrorResponse;

type RouteResult = {
	payload: OutgoingJsonRpcResponse | null;
	sessionId?: string;
	status?: number;
};

// An error the session layer answers with before routing.
type SessionError = {
	payload: JSONRPCErrorResponse;
	status: number;
};

const getJsonRpcId = (value: unknown): string | number | null => {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' && Number.isInteger(value)) return value;
	return null;
};

const parseIncomingJsonRpcMessage = (
	value: unknown,
): IncomingJsonRpcMessage | null => {
	const record = recordOf(value);
	if (!record) return null;
	if (record.jsonrpc !== JSONRPC_VERSION) return null;

	if ('method' in record) {
		if (typeof record.method !== 'string') return null;
		if ('result' in record || 'error' in record) return null;
		if ('params' in record && !recordOf(record.params)) return null;
		if ('id' in record) {
			const id = getJsonRpcId(record.id);
			if (id === null) return null;
			const message: IncomingJsonRpcRequest = {
				jsonrpc: JSONRPC_VERSION,
				method: record.method,
				id,
			};
			if ('params' in record) {
				message.params = record.params;
			}
			return message;
		}
		const message: IncomingJsonRpcNotification = {
			jsonrpc: JSONRPC_VERSION,
			method: record.method,
		};
		if ('params' in record) {
			message.params = record.params;
		}
		return message;
	}

	return jsonRpcResponseType.allows(record) ? record : null;
};

const rpcError = (
	id: string | number | undefined,
	code: number,
	message: string,
	data?: unknown,
): JSONRPCErrorResponse => ({
	jsonrpc: JSONRPC_VERSION,
	id,
	error:
		data === undefined
			? {
					code,
					message,
				}
			: {
					code,
					message,
					data,
				},
});

const isJsonRpcErrorResponse = (
	payload: OutgoingJsonRpcResponse | null,
): payload is JSONRPCErrorResponse => payload !== null && 'error' in payload;

const isIncomingJsonRpcNotification = (
	message: IncomingJsonRpcMessage,
): message is IncomingJsonRpcNotification => {
	return 'method' in message && !('id' in message);
};

const isIncomingJsonRpcResponse = (
	message: IncomingJsonRpcMessage,
): message is IncomingJsonRpcResponse => {
	return !('method' in message);
};

export type {
	IncomingJsonRpcMessage,
	IncomingJsonRpcNotification,
	IncomingJsonRpcRequest,
	IncomingJsonRpcResponse,
	OutgoingJsonRpcResponse,
	RouteResult,
	SessionError,
};
export {
	getJsonRpcId,
	isIncomingJsonRpcNotification,
	isIncomingJsonRpcResponse,
	isJsonRpcErrorResponse,
	parseIncomingJsonRpcMessage,
	rpcError,
};
