import type {
	JSONRPCErrorResponse,
	JSONRPCResultResponse,
} from '@modelcontextprotocol/sdk/types';

type IncomingJsonRpcRequest = {
	jsonrpc: '2.0';
	method: string;
	id: string | number;
	params?: unknown;
	result?: never;
	error?: never;
};

type IncomingJsonRpcNotification = {
	jsonrpc: '2.0';
	method: string;
	id?: never;
	params?: unknown;
	result?: never;
	error?: never;
};

type IncomingJsonRpcResultResponse = {
	jsonrpc: '2.0';
	method?: never;
	id: string | number;
	params?: never;
	result: unknown;
	error?: never;
};

type IncomingJsonRpcErrorResponse = {
	jsonrpc: '2.0';
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

const getRecord = (value: unknown): Record<string, unknown> | null => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
};

const getJsonRpcId = (value: unknown): string | number | null => {
	if (typeof value === 'string' || typeof value === 'number') return value;
	return null;
};

const getJsonRpcError = (
	value: unknown,
): IncomingJsonRpcErrorResponse['error'] | null => {
	const record = getRecord(value);
	if (!record) return null;
	if (typeof record.code !== 'number') return null;
	if (typeof record.message !== 'string') return null;
	const error: IncomingJsonRpcErrorResponse['error'] = {
		code: record.code,
		message: record.message,
	};
	if ('data' in record) {
		error.data = record.data;
	}
	return error;
};

const parseIncomingJsonRpcMessage = (
	value: unknown,
): IncomingJsonRpcMessage | null => {
	const record = getRecord(value);
	if (!record) return null;
	if (record.jsonrpc !== '2.0') return null;

	if ('method' in record) {
		if (typeof record.method !== 'string') return null;
		if ('id' in record) {
			const id = getJsonRpcId(record.id);
			if (id === null) return null;
			const message: IncomingJsonRpcRequest = {
				jsonrpc: '2.0',
				method: record.method,
				id,
			};
			if ('params' in record) {
				message.params = record.params;
			}
			return message;
		}
		const message: IncomingJsonRpcNotification = {
			jsonrpc: '2.0',
			method: record.method,
		};
		if ('params' in record) {
			message.params = record.params;
		}
		return message;
	}

	const hasResult = 'result' in record;
	const hasError = 'error' in record;
	if (hasResult === hasError) return null;
	if (hasResult) {
		const id = getJsonRpcId(record.id);
		if (id === null) return null;
		return {
			jsonrpc: '2.0',
			id,
			result: record.result,
		};
	}

	const error = getJsonRpcError(record.error);
	if (!error) return null;
	if (!('id' in record)) {
		return {
			jsonrpc: '2.0',
			error,
		};
	}
	const id = getJsonRpcId(record.id);
	if (id === null) return null;
	return {
		jsonrpc: '2.0',
		id,
		error,
	};
};

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
};
export {
	getJsonRpcId,
	getRecord,
	isIncomingJsonRpcNotification,
	isIncomingJsonRpcResponse,
	parseIncomingJsonRpcMessage,
};
