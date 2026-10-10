import {
	getJsonRpcId,
	parseIncomingJsonRpcMessage,
} from '@/server/gateway/json_rpc';

import { expect, test } from 'bun:test';

test('JSON-RPC IDs are strings or finite integers, including zero', () => {
	for (const id of [
		'',
		'request',
		0,
		-1,
		42,
	])
		expect(getJsonRpcId(id)).toBe(id);
	for (const id of [
		null,
		undefined,
		1.5,
		NaN,
		Infinity,
		-Infinity,
		true,
		{},
	])
		expect(getJsonRpcId(id)).toBeNull();
});

test('rejects mixed envelopes, non-object MCP params/results, and malformed errors', () => {
	const request = {
		jsonrpc: '2.0',
		id: 0,
		method: 'tools/call',
		params: {},
	};
	const response = {
		jsonrpc: '2.0',
		id: 0,
		result: {},
	};
	const error = {
		code: -32602,
		message: 'Invalid params',
		data: {
			detail: 'kept',
		},
	};
	for (const message of [
		request,
		response,
		{
			jsonrpc: '2.0',
			id: 'request',
			error,
		},
		{
			jsonrpc: '2.0',
			error,
		},
		{
			jsonrpc: '2.0',
			method: 'notifications/initialized',
		},
	]) {
		const parsed: unknown = parseIncomingJsonRpcMessage(message);
		expect(parsed).toEqual(message);
	}
	for (const message of [
		{
			...request,
			id: 1.5,
		},
		{
			...request,
			id: null,
		},
		{
			...request,
			result: {},
		},
		{
			...request,
			error,
		},
		{
			...request,
			params: [],
		},
		{
			...request,
			params: null,
		},
		{
			...request,
			params: 'invalid',
		},
		{
			...response,
			error,
		},
		{
			...response,
			result: [],
		},
		{
			...response,
			result: null,
		},
		{
			...response,
			result: 1,
		},
		{
			...response,
			params: {},
		},
		{
			...response,
			jsonrpc: '1.0',
		},
		{
			jsonrpc: '2.0',
			id: 0,
		},
		{
			jsonrpc: '2.0',
			id: 0,
			error: {
				...error,
				code: -32602.5,
			},
		},
		{
			jsonrpc: '2.0',
			id: 0,
			error: {
				...error,
				code: '-32602',
			},
		},
		{
			jsonrpc: '2.0',
			id: 0,
			error: {
				...error,
				message: {},
			},
		},
		{
			jsonrpc: '2.0',
			id: null,
			error,
		},
	])
		expect(parseIncomingJsonRpcMessage(message)).toBeNull();
});
