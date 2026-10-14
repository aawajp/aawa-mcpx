import type {
	GetPromptResult,
	Implementation,
	ListPromptsResult,
	ListResourcesResult,
	ListResourceTemplatesResult,
	ListToolsResult,
	ReadResourceResult,
	ServerCapabilities,
} from '@modelcontextprotocol/sdk/types';

import { logger } from '@/server/logger';
import type { McpUpstreamServer } from '@/server/mcp_upstreams/types';
import { errorMessage } from '@/shared/common';
import {
	CACHEABLE_METHODS,
	CLIENT_CAPABILITIES_META,
	CLIENT_INFO_META,
	CURRENT_PROTOCOL_VERSION,
	GATEWAY_INFO,
	type HeaderParameter,
	isProtocolVersion,
	PROTOCOL_VERSION_META,
	type ProtocolVersion,
	protocolHeaders,
	recordOf,
	requiresInitialization,
	SERVER_INFO_META,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@/shared/mcp_protocol';
import type { ToolCallResult } from '@/shared/mcp_results';
import {
	callToolResultType,
	getPromptResultType,
	jsonRpcResponseType,
	listPromptsResultType,
	listResourcesResultType,
	listResourceTemplatesResultType,
	listToolsResultType,
	readResourceResultType,
} from '@/shared/mcp_schemas';

type RequestOptions = {
	timeout?: number;
	signal?: AbortSignal;
	mirroredHeaders?: Record<string, string>;
	// The called tool's header rules; only tools/call has them.
	headerParameters?: HeaderParameter[] | Error;
};
const STDIO_LINE_LIMIT = 8 * 1024 * 1024;
// Each shutdown step waits this long for a stdio backend to exit.
const STDIO_EXIT_WAIT_MS = 1000;

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

class BackendTransportError extends Error {
	constructor(cause: unknown) {
		super(errorMessage(cause), {
			cause,
		});
	}
}

// An HTTP failure without a valid RPC error keeps only its status.
const httpError = (status: number): BackendRpcError =>
	new BackendRpcError(`Backend HTTP ${status}`, -32000, undefined, status);

const isTransientStatus = (status: number): boolean =>
	status === 408 || status === 429 || status >= 500;

const isTransientBackendError = (error: unknown): boolean =>
	error instanceof BackendTransportError ||
	(error instanceof BackendRpcError &&
		error.status !== undefined &&
		isTransientStatus(error.status));

// The versions a discovery result offers; one that offers 2026-07-28 must also
// report its capabilities.
const discoveredVersions = (
	details: Record<string, unknown>,
	requireCurrent = false,
): unknown[] => {
	const versions = details.supportedVersions;
	if (
		!Array.isArray(versions) ||
		(versions.includes(CURRENT_PROTOCOL_VERSION)
			? !recordOf(details.capabilities)
			: requireCurrent)
	)
		throw new Error('Invalid MCP 2026-07-28 discovery result');
	return versions;
};

const cancelledNotification = (requestId: string | number) => ({
	jsonrpc: '2.0',
	method: 'notifications/cancelled',
	params: {
		requestId,
	},
});

// An expired or wrong credential can be fixed without touching the gateway.
const isAuthenticationError = (error: unknown): boolean =>
	error instanceof BackendRpcError &&
	(error.status === 401 || error.status === 403);

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
	lastSuccessfulRequestAt = 0;
	onerror: (error: unknown) => void = () => undefined;
	ontransporterror: (error: unknown) => void = () => undefined;
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
			if (
				this.negotiationMethod === 'transport' ||
				isTransientBackendError(error) ||
				isAuthenticationError(error) ||
				this.isSessionLostError(error)
			)
				throw error;
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

	private isSessionLostError(error: unknown): boolean {
		return (
			error instanceof BackendRpcError &&
			error.status === 404 &&
			this.protocolVersion !== CURRENT_PROTOCOL_VERSION &&
			Boolean(this.sessionId)
		);
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
			this.child = Bun.spawn([config.command, ...(config.args ?? [])], {
				cwd: config.cwd,
				env: {
					...processEnvironment,
					...config.env,
				},
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe',
			});
			void this.readStdout(this.child.stdout);
			void this.readStderr(this.child.stderr);
		}
		// A 2025 revision a discovering peer offers instead of 2026-07-28.
		let offeredVersion: ProtocolVersion | undefined;
		if (!this.selected || this.selected === CURRENT_PROTOCOL_VERSION) {
			this.negotiationMethod = 'server/discover';
			// Probe with read-only 2026-07-28 discovery before attempting initialize.
			// A retained 2025 version skips probing on reconnect.
			try {
				this.protocolVersion = CURRENT_PROTOCOL_VERSION;
				this.details = await this.rpc('server/discover');
				const versions = discoveredVersions(this.details);
				if (versions.includes(CURRENT_PROTOCOL_VERSION)) return;
				// A peer without 2026-07-28 may still offer a 2025 revision; a
				// retained 2026-07-28 selection cannot change until restart.
				offeredVersion = this.selected
					? undefined
					: SUPPORTED_PROTOCOL_VERSIONS.find(
							(version) =>
								requiresInitialization(version) && versions.includes(version),
						);
				if (!offeredVersion)
					throw new Error(
						`Backend offers no supported protocol version: ${versions.join(', ')}`,
					);
				logger.info(
					`MCP upstream "${this.server.serverName}" offers ${offeredVersion}; initializing with it`,
				);
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
				if ([-32020, -32021, -32022].includes(error.code)) throw error;
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
						400, 404, 405,
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
			this.selected ??
			offeredVersion ??
			SUPPORTED_PROTOCOL_VERSIONS.find(requiresInitialization);
		if (!this.protocolVersion)
			throw new Error('No supported protocol version uses initialization');
		this.negotiationMethod = 'initialize';
		this.details = await this.rpc('initialize', {
			protocolVersion: this.protocolVersion,
			clientInfo: GATEWAY_INFO,
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

	// Splits a byte stream into lines, decoding UTF-8 across chunks. A line
	// over the limit fails the stream, or is passed on cut short when truncating.
	private async readLines(
		stream: ReadableStream<Uint8Array>,
		onLine: (line: string) => void,
		truncate: boolean,
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
				let end = buffer.indexOf('\n');
				while (end >= 0) {
					onLine(buffer.slice(0, end).trim());
					buffer = buffer.slice(end + 1);
					end = buffer.indexOf('\n');
				}
				if (buffer.length > STDIO_LINE_LIMIT) {
					if (!truncate) throw new Error('Backend message exceeds size limit');
					onLine(buffer);
					buffer = '';
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	private async readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
		try {
			await this.readLines(
				stream,
				(line) => {
					if (!line) return;
					let message: Record<string, unknown> | undefined;
					try {
						message = recordOf(JSON.parse(line));
					} catch {
						message = undefined;
					}
					// A server must not write anything but MCP messages to stdout. Skip
					// such output instead of losing the connection.
					if (!message) {
						logger.warn(
							`MCP upstream "${this.server.serverName}" wrote a non-JSON-RPC line to stdout`,
						);
						return;
					}
					const id = message.id;
					// JSON-RPC IDs belong to their sender: only a result or error
					// completes one of the gateway's requests.
					if ('method' in message) this.answerRequest(message);
					else if (
						(typeof id === 'string' || typeof id === 'number') &&
						('result' in message || 'error' in message)
					)
						this.pending.get(id)?.resolve(message);
				},
				false,
			);
			if (!this.closed) throw new Error('Backend stdout closed');
		} catch (error) {
			if (this.closed) return;
			const failure = new BackendTransportError(error);
			this.onerror(failure);
			this.ontransporterror(failure);
			for (const pending of this.pending.values()) pending.reject(failure);
		}
	}

	// Servers may log to stderr; it never affects the connection.
	private async readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
		await this.readLines(
			stream,
			(line) => {
				if (line) logger.info(`[${this.server.serverName}] ${line}`);
			},
			true,
		).catch(() => undefined);
	}

	// The receiver of a request must respond. The gateway answers a backend's
	// ping and declines every other backend request; notifications are ignored.
	private answerRequest(request: Record<string, unknown>): void {
		const id = request.id;
		if (typeof id !== 'string' && typeof id !== 'number') return;
		const legacy = this.protocolVersion !== CURRENT_PROTOCOL_VERSION;
		const response =
			legacy && request.method === 'ping'
				? {
						jsonrpc: '2.0',
						id,
						result: {},
					}
				: {
						jsonrpc: '2.0',
						id,
						error: {
							code: -32601,
							message: 'Method not found',
						},
					};
		const config = this.server.serverConfig;
		const answer = async (): Promise<void> => {
			if (config.type === 'stdio') {
				this.child?.stdin.write(`${JSON.stringify(response)}\n`);
				return;
			}
			// 2026-07-28 has no backend requests and no session to answer on.
			if (!legacy) return;
			const reply = await fetch(config.url, {
				method: 'POST',
				headers: this.httpHeaders(config.headers, response),
				body: JSON.stringify(response),
				signal: AbortSignal.timeout(config.timeout),
			});
			await reply.body?.cancel();
			if (!reply.ok) throw new Error(`HTTP ${reply.status}`);
		};
		answer().catch((error: unknown) => {
			logger.warn(
				JSON.stringify({
					message: 'Backend request answer failed',
					context: {
						backend: this.server.serverName,
						method: request.method,
					},
					error: errorMessage(error),
				}),
			);
		});
	}

	private async send(
		message: Record<string, unknown>,
		signal: AbortSignal,
		options: RequestOptions = {},
	): Promise<unknown> {
		if (signal.aborted) throw new BackendTransportError(signal.reason);
		const config = this.server.serverConfig;
		if (config.type === 'stdio') return this.sendStdio(message, signal);
		const response = await fetch(config.url, {
			method: 'POST',
			headers: this.httpHeaders(config.headers, message, options),
			body: JSON.stringify(message),
			signal,
		}).catch((error: unknown) => {
			throw new BackendTransportError(error);
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
		)
			return this.readEventStream(response, message.id);
		return this.readJsonResponse(response, message);
	}

	private async sendStdio(
		message: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		if (!this.child)
			throw new BackendTransportError(
				new Error('Backend process is not running'),
			);
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
				signal.removeEventListener('abort', abort);
				try {
					// Both 2025 revisions forbid cancelling initialize. Shutdown also
					// must not write to a process that is already being torn down.
					if (!this.closed && message.method !== 'initialize')
						child.stdin.write(`${JSON.stringify(cancelledNotification(id))}\n`);
				} catch (error) {
					logger.warn(
						JSON.stringify({
							message: 'Backend cancellation notification failed',
							context: {
								backend: this.server.serverName,
								requestId: id,
							},
							error: errorMessage(error),
						}),
					);
				} finally {
					reject(new BackendTransportError(signal.reason));
				}
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
			try {
				child.stdin.write(`${JSON.stringify(message)}\n`);
			} catch (error) {
				this.pending.get(id)?.reject(new BackendTransportError(error));
			}
		});
	}

	private httpHeaders(
		configured: Record<string, string> | undefined,
		message: Record<string, unknown>,
		options: RequestOptions = {},
	): Headers {
		const headers = new Headers(configured);
		// These fields belong to this RPC, never to static backend configuration.
		// Clear stale mirrors even for legacy hops, which do not validate them.
		for (const name of Array.from(headers.keys()))
			if (
				name === 'mcp-method' ||
				name === 'mcp-name' ||
				name.startsWith('mcp-param-')
			)
				headers.delete(name);
		headers.set('Content-Type', 'application/json');
		headers.set('Accept', 'application/json, text/event-stream');
		headers.delete('Mcp-Session-Id');
		headers.delete('Last-Event-ID');
		if (this.protocolVersion === CURRENT_PROTOCOL_VERSION) {
			// Preserve unrecognized mirrors on a modern HTTP hop. Recognized ones
			// below are rebuilt from this backend's schema and the translated body.
			for (const [name, value] of Object.entries(options.mirroredHeaders ?? {}))
				if (name.toLowerCase().startsWith('mcp-param-'))
					headers.set(name, value);
			const parameters = options.headerParameters ?? [];
			if (parameters instanceof Error) throw parameters;
			for (const parameter of parameters)
				headers.delete(`Mcp-Param-${parameter.name}`);
			for (const [name, value] of protocolHeaders(
				String(message.method),
				recordOf(message.params) ?? {},
				parameters,
			))
				headers.set(name, value);
		} else {
			headers.set(
				'MCP-Protocol-Version',
				this.protocolVersion ?? CURRENT_PROTOCOL_VERSION,
			);
			if (this.sessionId) headers.set('Mcp-Session-Id', this.sessionId);
		}
		return headers;
	}

	// A Streamable HTTP backend may answer a POST with an SSE stream instead of JSON.
	private async readEventStream(
		response: Response,
		id: unknown,
	): Promise<unknown> {
		if (!response.body) throw new Error('Missing backend stream');
		const reader = response.body
			.pipeThrough(new TextDecoderStream())
			.getReader();
		let buffer = '';
		// SSE lines end in \r\n, \n or \r. A chunk can end between \r and \n,
		// so a trailing \r waits for the next chunk.
		let carriageReturn = false;
		try {
			for (;;) {
				const next = await reader.read().catch((error: unknown) => {
					throw new BackendTransportError(error);
				});
				let text: string =
					(carriageReturn ? '\r' : '') + (next.done ? '' : next.value);
				carriageReturn = !next.done && text.endsWith('\r');
				if (carriageReturn) text = text.slice(0, -1);
				buffer += text.replace(/\r\n?/g, '\n');
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
						if (event && 'method' in event) this.answerRequest(event);
						else if (
							event &&
							event.id === id &&
							('result' in event || 'error' in event)
						)
							return event;
					}
					end = buffer.indexOf('\n\n');
				}
				if (next.done) break;
			}
			throw new BackendTransportError(
				new Error('Backend stream ended without a result'),
			);
		} finally {
			// An errored stream also rejects cancel(); preserve the transport error.
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
	}

	private async readJsonResponse(
		response: Response,
		message: Record<string, unknown>,
	): Promise<unknown> {
		const text = await response.text().catch((error: unknown) => {
			throw new BackendTransportError(error);
		});
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			if (response.ok) throw new Error('Invalid backend JSON response');
			throw httpError(response.status);
		}
		const bodyRecord = recordOf(body);
		// HTTP failures without an RPC envelope still carry status for recovery and
		// legacy negotiation. A claimed RPC error must validate before forwarding;
		// otherwise a wrong ID or malformed code could bypass rpc() below.
		if (
			response.ok ||
			(bodyRecord &&
				('jsonrpc' in bodyRecord ||
					'error' in bodyRecord ||
					'result' in bodyRecord ||
					'id' in bodyRecord))
		) {
			if (
				!jsonRpcResponseType.allows(body) ||
				('id' in message && body.id !== message.id)
			) {
				const error = new Error('Invalid backend RPC response');
				// Legacy HTTP servers can reject an unrecognized discovery probe
				// before associating its ID (for example, HTTP 400 with id:null).
				// Only the first discovery probe may use this transport rejection to
				// try initialization. Discard all unvalidated RPC code/message/data;
				// pinned peers and application responses still require a matching ID.
				if (
					!this.selected &&
					this.protocolVersion === CURRENT_PROTOCOL_VERSION &&
					message.method === 'server/discover' &&
					[400, 404, 405].includes(response.status)
				)
					throw new BackendRpcError(
						`Backend HTTP ${response.status} rejected discovery`,
						-32000,
						undefined,
						response.status,
					);
				// A transient HTTP failure keeps its status even when its body is
				// malformed. Never expose that body's unvalidated protocol code/data.
				if (isTransientStatus(response.status))
					throw httpError(response.status);
				throw error;
			}
			if (body.error)
				throw new BackendRpcError(
					body.error.message,
					body.error.code,
					body.error.data,
					response.status,
				);
		}
		if (!response.ok) {
			throw httpError(response.status);
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
		const timeoutMs = options.timeout ?? this.server.serverConfig.timeout;
		// A named reason keeps timeouts distinct from cancellations in errors and logs.
		const timeout = setTimeout(
			() =>
				controller.abort(
					new DOMException(
						`Backend request timed out after ${timeoutMs} ms`,
						'TimeoutError',
					),
				),
			timeoutMs,
		);
		const signal = options.signal
			? AbortSignal.any([controller.signal, options.signal])
			: controller.signal;
		const id = ++this.sequence;
		const usesRequestMetadata =
			this.protocolVersion === CURRENT_PROTOCOL_VERSION;
		// Preserve application/vendor metadata, but never carry another hop's
		// protocol identity or operation handles into this backend connection.
		// This gateway does not relay progress/log notifications or implement tasks
		// and subscriptions, so it cannot opt backend requests into those flows.
		// Metadata was validated at the public boundary; adaptation is not validation.
		const metadata = {
			...recordOf(params._meta),
		};
		for (const key of [
			PROTOCOL_VERSION_META,
			CLIENT_INFO_META,
			CLIENT_CAPABILITIES_META,
			SERVER_INFO_META,
			'progressToken',
			'io.modelcontextprotocol/logLevel',
			'io.modelcontextprotocol/subscriptionId',
			'io.modelcontextprotocol/related-task',
		])
			delete metadata[key];
		if (usesRequestMetadata) {
			metadata[PROTOCOL_VERSION_META] = this.protocolVersion;
			metadata[CLIENT_INFO_META] = GATEWAY_INFO;
			metadata[CLIENT_CAPABILITIES_META] = {};
		}
		const bodyParams = {
			...params,
		};
		delete bodyParams._meta;
		if (Object.keys(metadata).length > 0) bodyParams._meta = metadata;
		let sent = false;
		try {
			signal.throwIfAborted();
			sent = true;
			const response = await this.send(
				{
					jsonrpc: '2.0',
					id,
					method,
					params: bodyParams,
				},
				signal,
				options,
			);
			// A transport or provider may finish after cancellation. Never accept
			// that result or update connection health for an abandoned operation.
			signal.throwIfAborted();
			if (!jsonRpcResponseType.allows(response) || response.id !== id)
				throw new Error('Invalid backend RPC response');
			const error = response.error;
			if (error)
				throw new BackendRpcError(error.message, error.code, error.data);
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
					!['public', 'private'].includes(String(result.cacheScope)))
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
				case 'resources/templates/list':
					listResourceTemplatesResultType.assert(result);
					break;
				case 'tools/call':
					callToolResultType.assert(result);
					if (
						requiresInitialization(this.protocolVersion ?? '') &&
						result.structuredContent !== undefined &&
						!recordOf(result.structuredContent)
					)
						throw new Error('MCP 2025 structuredContent must be a JSON object');
					break;
				case 'prompts/get':
					getPromptResultType.assert(result);
					break;
				case 'resources/read':
					readResourceResultType.assert(result);
					break;
			}
			this.lastSuccessfulRequestAt = Date.now();
			return result;
		} catch (error) {
			const failure = signal.aborted
				? new BackendTransportError(signal.reason)
				: error;
			if (
				sent &&
				signal.aborted &&
				!this.closed &&
				method !== 'initialize' &&
				this.server.serverConfig.type === 'http' &&
				!usesRequestMetadata
			) {
				// Legacy HTTP does not equate disconnect with cancellation. Notify
				// using this hop's ID/session and a fresh, bounded signal. Modern HTTP
				// cancels by closing the response stream, so no notification is sent.
				void this.send(
					cancelledNotification(id),
					AbortSignal.timeout(1000),
				).catch(() => undefined);
			}
			// Only a lost connection or session retires the client. A timeout or an
			// HTTP error fails this call alone; health checks catch a hung backend.
			// Never replay an operation: a lost response does not establish whether
			// its side effects completed.
			if (
				!this.closed &&
				!signal.aborted &&
				method !== 'ping' &&
				method !== 'server/discover' &&
				(failure instanceof BackendTransportError ||
					this.isSessionLostError(failure))
			)
				this.ontransporterror(failure);
			throw failure;
		} finally {
			clearTimeout(timeout);
			this.controllers.delete(controller);
		}
	}

	// 2026-07-28 discovery is stateless, so a backend can change what it
	// reports without a new connection. A 2025 session keeps its initialize result.
	async rediscover(): Promise<void> {
		if (this.protocolVersion !== CURRENT_PROTOCOL_VERSION) return;
		const details = await this.rpc('server/discover');
		discoveredVersions(details, true);
		this.details = details;
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
	// key names the result field holding the listed items.
	private async list(
		method: string,
		key: string,
		params: Record<string, unknown>,
		options?: RequestOptions,
	): Promise<Record<string, unknown>> {
		const receivedAt = Date.now();
		// rpc validated each page against the method's result type.
		const first = await this.rpc(method, params, options);
		const items = [...(first[key] as unknown[])];
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
			items.push(...(page[key] as unknown[]));
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
		return (await this.list(
			'tools/list',
			'tools',
			params,
			options,
		)) as ListToolsResult;
	}
	async listPrompts(
		params: Record<string, unknown> = {},
		options?: RequestOptions,
	): Promise<ListPromptsResult> {
		return (await this.list(
			'prompts/list',
			'prompts',
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
			'resources',
			params,
			options,
		)) as ListResourcesResult;
	}
	async listResourceTemplates(
		params: Record<string, unknown> = {},
		options?: RequestOptions,
	): Promise<ListResourceTemplatesResult> {
		return (await this.list(
			'resources/templates/list',
			'resourceTemplates',
			params,
			options,
		)) as ListResourceTemplatesResult;
	}
	async callTool(
		params: {
			name: string;
			arguments?: Record<string, unknown>;
			_meta?: Record<string, unknown>;
		},
		options?: RequestOptions,
	): Promise<ToolCallResult> {
		return (await this.rpc('tools/call', params, options)) as ToolCallResult;
	}
	async getPrompt(
		params: {
			name: string;
			arguments?: Record<string, string>;
			_meta?: Record<string, unknown>;
		},
		options?: RequestOptions,
	): Promise<GetPromptResult> {
		return (await this.rpc('prompts/get', params, options)) as GetPromptResult;
	}
	async readResource(
		params: {
			uri: string;
			_meta?: Record<string, unknown>;
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
		const config = this.server.serverConfig;
		if (config.type === 'http' && this.sessionId) {
			// End the 2025 backend session. A server may refuse with HTTP 405.
			await fetch(config.url, {
				method: 'DELETE',
				headers: this.httpHeaders(config.headers, {}),
				signal: AbortSignal.timeout(config.timeout),
			})
				.then((response) => response.body?.cancel())
				.catch(() => undefined);
			this.sessionId = undefined;
		}
		const child = this.child;
		if (!child) return;
		// The stdio shutdown sequence: close stdin, then SIGTERM, then SIGKILL,
		// each with a time limit.
		const exited = async (): Promise<boolean> =>
			Promise.race([
				child.exited.then(() => true),
				Bun.sleep(STDIO_EXIT_WAIT_MS).then(() => false),
			]);
		try {
			await child.stdin.end();
		} catch {
			// The process may already have closed its stdin.
		}
		if (await exited()) return;
		child.kill('SIGTERM');
		if (await exited()) return;
		child.kill('SIGKILL');
		await exited();
	}
}

export {
	BackendRpcError,
	BackendTransportError,
	isAuthenticationError,
	ProtocolClient,
	ProtocolNegotiationError,
};
