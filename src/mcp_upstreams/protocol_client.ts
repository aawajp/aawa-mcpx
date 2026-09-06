import type {
	CallToolResult,
	GetPromptResult,
	Implementation,
	ListPromptsResult,
	ListResourcesResult,
	ListToolsResult,
	ReadResourceResult,
	ServerCapabilities,
} from '@modelcontextprotocol/sdk/types';

import type { McpUpstreamServer } from '@/mcp_upstreams/types';
import { logger } from '@/server/logger';
import { errorMessage } from '@/shared/common';
import {
	CACHEABLE_METHODS,
	CLIENT_CAPABILITIES_META,
	CLIENT_INFO_META,
	CURRENT_PROTOCOL_VERSION,
	isProtocolVersion,
	PROTOCOL_VERSION_META,
	type ProtocolVersion,
	protocolHeaders,
	recordOf,
	requiresInitialization,
	SERVER_INFO_META,
	SUPPORTED_PROTOCOL_VERSIONS,
	toolHeaderParameters,
} from '@/shared/mcp_protocol';
import {
	callToolResultType,
	getPromptResultType,
	listPromptsResultType,
	listResourcesResultType,
	listToolsResultType,
	readResourceResultType,
} from '@/shared/mcp_schemas';

type RequestOptions = {
	timeout?: number;
	signal?: AbortSignal;
};
class BackendRpcError extends Error {
	constructor(
		message: string,
		readonly code: number,
		readonly data?: unknown,
		readonly status?: number,
	) {
		super(message);
	}
}

class ProtocolNegotiationError extends Error {
	constructor(
		readonly context: {
			method: string;
			attemptedVersion?: string;
			selectedVersion?: string;
			httpStatus?: number;
			rpcCode?: number;
		},
		cause: unknown,
	) {
		super(
			`Protocol negotiation failed at ${context.method} (attempted ${context.attemptedVersion ?? 'unknown'}, HTTP ${context.httpStatus ?? 'n/a'}, RPC ${context.rpcCode ?? 'n/a'}): ${errorMessage(cause)}`,
			{
				cause,
			},
		);
	}
}

// One instance owns one connection. The manager owns the longer-lived version selection.
class ProtocolClient {
	protocolVersion?: ProtocolVersion;
	onerror: (error: unknown) => void = () => undefined;
	private sequence = 0;
	private sessionId?: string;
	private details: Record<string, unknown> = {};
	private child?: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
	private pending = new Map<
		string | number,
		{
			resolve: (value: unknown) => void;
			reject: (error: unknown) => void;
		}
	>();
	private controllers = new Set<AbortController>();
	private tools = new Map<string, unknown>();
	private closed: boolean = false;
	private negotiationMethod = 'transport';

	constructor(
		private server: McpUpstreamServer,
		private selected?: ProtocolVersion,
	) {}

	getServerCapabilities(): ServerCapabilities | undefined {
		return this.details.capabilities as ServerCapabilities | undefined;
	}
	getServerVersion(): Implementation | undefined {
		return (this.details.serverInfo ??
			recordOf(this.details._meta)?.[SERVER_INFO_META]) as
			| Implementation
			| undefined;
	}
	getInstructions(): string | undefined {
		return typeof this.details.instructions === 'string'
			? this.details.instructions
			: undefined;
	}

	async connect(): Promise<void> {
		try {
			await this.establishConnection();
		} catch (error) {
			if (this.negotiationMethod === 'transport') throw error;
			throw new ProtocolNegotiationError(
				{
					method: this.negotiationMethod,
					attemptedVersion: this.protocolVersion,
					selectedVersion: this.selected,
					httpStatus:
						error instanceof BackendRpcError ? error.status : undefined,
					rpcCode: error instanceof BackendRpcError ? error.code : undefined,
				},
				error,
			);
		}
	}

	private async establishConnection(): Promise<void> {
		const config = this.server.serverConfig;
		if (config.type === 'stdio') {
			// Inherit process-launch settings only; backend-specific credentials
			// must come from its configuration, not unrelated gateway variables.
			const processEnvironment: Record<string, string> = {};
			for (const key of [
				'HOME',
				'PATH',
				'SHELL',
				'USER',
				'LOGNAME',
				'TMPDIR',
				'SystemRoot',
				'TEMP',
			]) {
				const value = process.env[key];
				if (value !== undefined) processEnvironment[key] = value;
			}
			this.child = Bun.spawn(
				[
					config.command,
					...(config.args ?? []),
				],
				{
					cwd: config.cwd,
					env: {
						...processEnvironment,
						...config.env,
					},
					stdin: 'pipe',
					stdout: 'pipe',
					stderr: 'pipe',
				},
			);
			void this.readLines(this.child.stdout, false);
			void this.readLines(this.child.stderr, true);
		}
		if (!this.selected || this.selected === CURRENT_PROTOCOL_VERSION) {
			this.negotiationMethod = 'server/discover';
			// Probe with read-only 2026-07-28 discovery before attempting initialize.
			// A retained 2025 version skips probing on reconnect.
			try {
				this.protocolVersion = CURRENT_PROTOCOL_VERSION;
				this.details = await this.rpc('server/discover');
				if (
					!Array.isArray(this.details.supportedVersions) ||
					!this.details.supportedVersions.includes(CURRENT_PROTOCOL_VERSION) ||
					!recordOf(this.details.capabilities)
				)
					throw new Error('Invalid MCP 2026-07-28 discovery result');
				return;
			} catch (error) {
				// A retained selection is immutable until gateway restart. Header,
				// capability, and version errors identify a 2026-07-28-aware peer;
				// they must not trigger an initialization handshake.
				if (this.selected || !(error instanceof BackendRpcError)) throw error;
				if (
					config.type === 'http' &&
					error.status === 404 &&
					error.code === -32601
				)
					throw error;
				if (
					[
						-32020,
						-32021,
						-32022,
					].includes(error.code)
				)
					throw error;
				if (
					config.type === 'http' &&
					// Compatibility deviation from the 2026-07-28 HTTP fallback guidance:
					// some initialization-based servers reject discovery with HTTP 200
					// rather than HTTP 400. Accept only method/invalid-request errors here;
					// this exception never replays application requests.
					!(
						(error.status === 200 || error.status === undefined) &&
						(error.code === -32601 || error.code === -32600)
					) &&
					![
						// Only endpoint/protocol rejection permits HTTP fallback; an auth,
						// rate-limit, network, or server failure does not establish version support.
						400,
						404,
						405,
					].includes(error.status ?? 0)
				)
					throw error;
				logger.info(
					JSON.stringify({
						message:
							'Backend discovery rejected; falling back to initialization',
						context: {
							backend: this.server.serverName,
							transport: config.type,
							method: 'server/discover',
							attemptedVersion: this.protocolVersion,
							httpStatus: error.status,
							rpcCode: error.code,
							nextVersion: SUPPORTED_PROTOCOL_VERSIONS.find(
								requiresInitialization,
							),
						},
						error: error.message,
					}),
				);
			}
		}
		this.protocolVersion =
			this.selected ?? SUPPORTED_PROTOCOL_VERSIONS.find(requiresInitialization);
		if (!this.protocolVersion)
			throw new Error('No supported protocol version uses initialization');
		this.negotiationMethod = 'initialize';
		this.details = await this.rpc('initialize', {
			protocolVersion: this.protocolVersion,
			clientInfo: {
				name: 'aawa-mcpx',
				version: '1.0.0',
			},
			capabilities: {},
		});
		const negotiated = this.details.protocolVersion;
		if (
			!isProtocolVersion(negotiated) ||
			negotiated === CURRENT_PROTOCOL_VERSION ||
			(this.selected && negotiated !== this.selected)
		)
			throw new Error(
				`Unsupported backend protocol selection: ${String(negotiated)}`,
			);
		this.protocolVersion = negotiated;
		this.negotiationMethod = 'notifications/initialized';
		await this.send(
			{
				jsonrpc: '2.0',
				method: 'notifications/initialized',
			},
			AbortSignal.timeout(config.timeout),
		);
	}

	private async readLines(
		stream: ReadableStream<Uint8Array>,
		stderr: boolean,
	): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				buffer += decoder.decode(next.value, {
					stream: true,
				});
				if (buffer.length > 8 * 1024 * 1024)
					throw new Error('Backend message exceeds size limit');
				let end = buffer.indexOf('\n');
				while (end >= 0) {
					const line = buffer.slice(0, end).trim();
					buffer = buffer.slice(end + 1);
					if (line && !stderr) {
						const message = recordOf(JSON.parse(line));
						const id = message?.id;
						if (typeof id === 'string' || typeof id === 'number')
							this.pending.get(id)?.resolve(message);
					}
					end = buffer.indexOf('\n');
				}
			}
			if (!stderr && !this.closed) throw new Error('Backend stdout closed');
		} catch (error) {
			if (!this.closed) {
				this.onerror(error);
				for (const pending of this.pending.values()) pending.reject(error);
			}
		} finally {
			reader.releaseLock();
		}
	}

	private async send(
		message: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		signal.throwIfAborted();
		const config = this.server.serverConfig;
		if (config.type === 'stdio') {
			if (!this.child) throw new Error('Backend process is not running');
			const child = this.child;
			const id = message.id;
			if (typeof id !== 'string' && typeof id !== 'number') {
				child.stdin.write(`${JSON.stringify(message)}\n`);
				return undefined;
			}
			return await new Promise((resolve, reject) => {
				const abort = (): void => {
					// Retire the ID before cancellation so a late stdio response cannot
					// complete an abandoned discovery probe or another operation.
					this.pending.delete(id);
					child.stdin.write(
						`${JSON.stringify({
							jsonrpc: '2.0',
							method: 'notifications/cancelled',
							params: {
								requestId: id,
							},
						})}\n`,
					);
					reject(
						new BackendRpcError(
							'Backend request timed out or cancelled',
							-32000,
						),
					);
				};
				this.pending.set(id, {
					resolve: (value) => {
						signal.removeEventListener('abort', abort);
						this.pending.delete(id);
						resolve(value);
					},
					reject: (error) => {
						signal.removeEventListener('abort', abort);
						this.pending.delete(id);
						reject(error);
					},
				});
				signal.addEventListener('abort', abort, {
					once: true,
				});
				child.stdin.write(`${JSON.stringify(message)}\n`);
			});
		}
		const headers = new Headers(config.headers as HeadersInit | undefined);
		headers.set('Content-Type', 'application/json');
		headers.set('Accept', 'application/json, text/event-stream');
		headers.delete('Mcp-Session-Id');
		headers.delete('Last-Event-ID');
		if (this.protocolVersion === CURRENT_PROTOCOL_VERSION) {
			const params = recordOf(message.params) ?? {};
			for (const [name, value] of protocolHeaders(
				String(message.method),
				params,
				this.tools.get(String(params.name)),
			))
				headers.set(name, value);
		} else {
			headers.set(
				'MCP-Protocol-Version',
				this.protocolVersion ?? CURRENT_PROTOCOL_VERSION,
			);
			if (this.sessionId) headers.set('Mcp-Session-Id', this.sessionId);
		}
		const response = await fetch(config.url, {
			method: 'POST',
			headers,
			body: JSON.stringify(message),
			signal,
		});
		if (
			this.protocolVersion !== CURRENT_PROTOCOL_VERSION &&
			message.method === 'initialize'
		)
			this.sessionId = response.headers.get('Mcp-Session-Id') ?? undefined;
		if (!('id' in message) && response.ok) return undefined;
		if (
			response.headers.get('content-type')?.includes('text/event-stream') &&
			response.ok
		) {
			if (!response.body) throw new Error('Missing backend stream');
			const reader = response.body
				.pipeThrough(new TextDecoderStream())
				.getReader();
			let buffer = '';
			try {
				for (;;) {
					const next = await reader.read();
					if (next.done) break;
					buffer = (buffer + next.value).replaceAll('\r\n', '\n');
					if (buffer.length > 8 * 1024 * 1024)
						throw new Error('Backend event exceeds size limit');
					let end = buffer.indexOf('\n\n');
					while (end >= 0) {
						const data = buffer
							// SSE events can span chunks and contain multiple data lines.
							.slice(0, end)
							.split('\n')
							.filter((line) => line.startsWith('data:'))
							.map((line) => line.slice(5).replace(/^ /, ''))
							.join('\n');
						buffer = buffer.slice(end + 2);
						if (data) {
							// Progress notifications are not the final response. Complete only
							// when this request's ID has a result or protocol error.
							const event = recordOf(JSON.parse(data));
							if (
								event &&
								event.id === message.id &&
								('result' in event || 'error' in event)
							)
								return event;
						}
						end = buffer.indexOf('\n\n');
					}
				}
				throw new Error('Backend stream ended without a result');
			} finally {
				await reader.cancel();
				reader.releaseLock();
			}
		}
		const text = await response.text();
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			throw new BackendRpcError(
				`Backend HTTP ${response.status}`,
				-32000,
				undefined,
				response.status,
			);
		}
		if (!response.ok || recordOf(recordOf(body)?.error)) {
			const error = recordOf(recordOf(body)?.error);
			throw new BackendRpcError(
				String(error?.message ?? `Backend HTTP ${response.status}`),
				typeof error?.code === 'number' ? error.code : -32000,
				error?.data,
				response.status,
			);
		}
		return body;
	}

	async rpc(
		method: string,
		params: Record<string, unknown> = {},
		options: RequestOptions = {},
	): Promise<Record<string, unknown>> {
		if (this.closed) throw new Error('Backend connection closed');
		const controller = new AbortController();
		this.controllers.add(controller);
		const timeout = setTimeout(
			() => controller.abort(),
			options.timeout ?? this.server.serverConfig.timeout,
		);
		const signal = options.signal
			? AbortSignal.any([
					controller.signal,
					options.signal,
				])
			: controller.signal;
		const id = ++this.sequence;
		const usesRequestMetadata =
			this.protocolVersion === CURRENT_PROTOCOL_VERSION;
		const bodyParams = usesRequestMetadata
			? {
					...params,
					_meta: {
						...recordOf(params._meta),
						[PROTOCOL_VERSION_META]: this.protocolVersion,
						[CLIENT_INFO_META]: {
							name: 'aawa-mcpx',
							version: '1.0.0',
						},
						[CLIENT_CAPABILITIES_META]: {},
					},
				}
			: params;
		try {
			const response = recordOf(
				await this.send(
					{
						jsonrpc: '2.0',
						id,
						method,
						params: bodyParams,
					},
					signal,
				),
			);
			if (response?.jsonrpc !== '2.0' || response.id !== id)
				throw new Error('Invalid backend RPC response');
			const error = recordOf(response.error);
			if (error)
				throw new BackendRpcError(
					String(error.message),
					Number(error.code),
					error.data,
				);
			const result = recordOf(response.result);
			if (!result) throw new Error('Missing backend result');
			if (usesRequestMetadata && result.resultType !== 'complete')
				throw new Error(
					`Unsupported backend result type: ${String(result.resultType)}; interactive requests are not supported`,
				);
			if (
				usesRequestMetadata &&
				CACHEABLE_METHODS.has(method) &&
				(!Number.isInteger(result.ttlMs) ||
					Number(result.ttlMs) < 0 ||
					![
						'public',
						'private',
					].includes(String(result.cacheScope)))
			)
				throw new Error('Invalid MCP 2026-07-28 cache hints');
			switch (method) {
				case 'tools/list':
					listToolsResultType.assert(result);
					break;
				case 'prompts/list':
					listPromptsResultType.assert(result);
					break;
				case 'resources/list':
					listResourcesResultType.assert(result);
					break;
				case 'tools/call':
					callToolResultType.assert(result);
					break;
				case 'prompts/get':
					getPromptResultType.assert(result);
					break;
				case 'resources/read':
					readResourceResultType.assert(result);
					break;
			}
			return result;
		} finally {
			clearTimeout(timeout);
			this.controllers.delete(controller);
		}
	}

	async ping(options?: RequestOptions): Promise<Record<string, unknown>> {
		return this.rpc(
			this.protocolVersion === CURRENT_PROTOCOL_VERSION
				? 'server/discover'
				: 'ping',
			{},
			options,
		);
	}
	private async list(
		method: string,
		params: Record<string, unknown>,
		options?: RequestOptions,
	): Promise<Record<string, unknown>> {
		const receivedAt = Date.now();
		const key = method.split('/')[0] ?? '';
		const first = await this.rpc(method, params, options);
		if (!Array.isArray(first[key])) throw new Error(`Invalid ${method} result`);
		const items: unknown[] = [
			...first[key],
		];
		const cursors = new Set<string>();
		let cursor = first.nextCursor;
		let ttl = Number(first.ttlMs ?? 0);
		while (typeof cursor === 'string') {
			if (cursors.has(cursor) || cursors.size >= 1000)
				throw new Error('Backend pagination did not terminate');
			cursors.add(cursor);
			const page = await this.rpc(
				method,
				{
					...params,
					cursor,
				},
				options,
			);
			if (!Array.isArray(page[key])) throw new Error(`Invalid ${method} page`);
			items.push(...page[key]);
			ttl = Math.min(ttl, Number(page.ttlMs ?? 0));
			cursor = page.nextCursor;
		}
		// Materialize all pages: an upstream cursor cannot describe the gateway's
		// combined catalog. Subtract fetch time so paging cannot extend freshness.
		const result = {
			...first,
			[key]: items,
			ttlMs: Math.max(0, ttl - (Date.now() - receivedAt)),
		};
		delete result.nextCursor;
		return result;
	}
	async listTools(
		params: Record<string, unknown> = {},
		options?: RequestOptions,
	): Promise<ListToolsResult> {
		const result = (await this.list(
			'tools/list',
			params,
			options,
		)) as ListToolsResult;
		if (!Array.isArray(result.tools))
			throw new Error('Invalid tools/list result');
		this.tools.clear();
		result.tools = result.tools.filter((tool) => {
			try {
				if (
					this.server.serverConfig.type === 'http' &&
					this.protocolVersion === CURRENT_PROTOCOL_VERSION
				)
					toolHeaderParameters(tool.inputSchema);
				this.tools.set(tool.name, tool.inputSchema);
				return true;
			} catch (error) {
				this.onerror(error);
				return false;
			}
		});
		return result;
	}
	async listPrompts(
		params: Record<string, unknown> = {},
		options?: RequestOptions,
	): Promise<ListPromptsResult> {
		return (await this.list(
			'prompts/list',
			params,
			options,
		)) as ListPromptsResult;
	}
	async listResources(
		params: Record<string, unknown> = {},
		options?: RequestOptions,
	): Promise<ListResourcesResult> {
		return (await this.list(
			'resources/list',
			params,
			options,
		)) as ListResourcesResult;
	}
	async callTool(
		params: {
			name: string;
			arguments?: Record<string, unknown>;
		},
		_schema?: unknown,
		options?: RequestOptions,
	): Promise<CallToolResult> {
		return (await this.rpc('tools/call', params, options)) as CallToolResult;
	}
	async getPrompt(
		params: {
			name: string;
			arguments?: Record<string, string>;
		},
		options?: RequestOptions,
	): Promise<GetPromptResult> {
		return (await this.rpc('prompts/get', params, options)) as GetPromptResult;
	}
	async readResource(
		params: {
			uri: string;
		},
		options?: RequestOptions,
	): Promise<ReadResourceResult> {
		return (await this.rpc(
			'resources/read',
			params,
			options,
		)) as ReadResourceResult;
	}
	async close(): Promise<void> {
		this.closed = true;
		for (const controller of this.controllers) controller.abort();
		this.child?.kill();
		if (this.child) await this.child.exited;
	}
}

export { BackendRpcError, ProtocolClient, ProtocolNegotiationError };
