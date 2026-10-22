import { type SubmitEvent, useMemo, useState } from 'react';

import { errorMessage } from '@/shared/common';
import { addPrefix, addResourcePrefix } from '@/shared/mcp_namespaces';
import {
	CLIENT_CAPABILITIES_META,
	CLIENT_INFO_META,
	CURRENT_PROTOCOL_VERSION,
	GATEWAY_INFO,
	PROTOCOL_VERSION_META,
	protocolHeaders,
	recordOf,
	toolHeaderParameters,
} from '@/shared/mcp_protocol';
import {
	type BackendOverview,
	TESTER_PATH,
	type TesterResponse,
	type Tool,
	testerResponseType,
} from '@/shared/ui_api';
import { postJson, useRequest } from '@/ui/api/client';
import { Button } from '@/ui/base_components/button';
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@/ui/base_components/card';
import { INPUT_CLASS } from '@/ui/base_components/classes';
import { JsonPreview } from '@/ui/components/JsonPreview';
import { t } from '@/ui/i18n';

// The Tester speaks only the latest MCP revision; every request runs only
// when the user presses Run.
const METHODS = [
	'server/discover',
	'ping',
	'tools/list',
	'tools/call',
	'prompts/list',
	'prompts/get',
	'resources/list',
	'resources/templates/list',
	'resources/read',
	'completion/complete',
] as const;
type Method = (typeof METHODS)[number];
const LIST_METHODS = new Set<Method>([
	'tools/list',
	'prompts/list',
	'resources/list',
	'resources/templates/list',
]);
const TESTER_CLIENT_INFO = {
	name: `${GATEWAY_INFO.name}-tester`,
	version: GATEWAY_INFO.version,
};
type FieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'json';
const SCALAR_KINDS = ['boolean', 'number', 'integer'] as const;

type ToolField = {
	name: string;
	required: boolean;
	kind: FieldKind;
	description?: string;
	enumOptions?: {
		value: string;
		label: string;
	}[];
	defaultValue?: string;
};

// A schema's type, or the first of a list of types.
const getSchemaType = (value: unknown) =>
	[value].flat().find((item): item is string => typeof item === 'string');

// A field's first text: its schema default, else an enum's first option.
const defaultText = (
	kind: FieldKind,
	value: unknown,
	firstOption?: string,
): string | undefined => {
	if (value === undefined) return kind === 'enum' ? firstOption : undefined;
	if (kind === 'enum') return JSON.stringify(value);
	if (kind === 'json') return JSON.stringify(value, null, 2);
	const text = ['string', 'number', 'boolean'].includes(typeof value)
		? String(value)
		: undefined;
	return kind === 'boolean' && text !== 'true' && text !== 'false'
		? undefined
		: text;
};

const getToolFields = (tool?: Tool): ToolField[] => {
	if (!tool) return [];
	const schema = recordOf(tool.inputSchema);
	if (!schema) return [];
	const properties = recordOf(schema.properties);
	if (!properties) return [];
	const required = new Set(
		(Array.isArray(schema.required) ? schema.required : []).filter(
			(item): item is string => typeof item === 'string',
		),
	);

	const fields: ToolField[] = [];
	for (const [name, rawProperty] of Object.entries(properties)) {
		const property = recordOf(rawProperty);
		if (!property) continue;
		const typeName = getSchemaType(property.type);
		const enumOptions =
			Array.isArray(property.enum) && property.enum.length > 0
				? property.enum.map((item: unknown) => ({
						value: JSON.stringify(item),
						label: typeof item === 'string' ? item : JSON.stringify(item),
					}))
				: undefined;
		const kind: FieldKind = enumOptions
			? 'enum'
			: typeName === 'string' &&
					!('anyOf' in property) &&
					!('oneOf' in property)
				? 'string'
				: (SCALAR_KINDS.find((scalar) => scalar === typeName) ?? 'json');
		fields.push({
			name,
			required: required.has(name),
			kind,
			description:
				typeof property.description === 'string'
					? property.description
					: undefined,
			enumOptions,
			defaultValue: defaultText(
				kind,
				property.default,
				enumOptions?.[0]?.value,
			),
		});
	}

	return fields;
};

// Tool arguments from the form, or the reason they are invalid.
const parseArguments = (
	fields: ToolField[],
	values: Record<string, string>,
): Record<string, unknown> | string => {
	const args: Record<string, unknown> = {};
	for (const field of fields) {
		const raw = values[field.name] ?? '';
		const text = field.kind === 'boolean' ? raw : raw.trim();
		if (text === '') {
			if (field.required) return `${t('tester.error.required')} ${field.name}`;
			continue;
		}
		if (field.kind === 'boolean') args[field.name] = text === 'true';
		else if (field.kind === 'number' || field.kind === 'integer') {
			const value = Number(text);
			if (
				Number.isNaN(value) ||
				(field.kind === 'integer' && !Number.isInteger(value))
			)
				return `${t(field.kind === 'integer' ? 'tester.error.integer' : 'tester.error.number')} ${field.name}`;
			args[field.name] = value;
		} else if (field.kind === 'enum' || field.kind === 'json') {
			try {
				args[field.name] = JSON.parse(text);
			} catch {
				return `${t('tester.error.json')} ${field.name}`;
			}
		} else args[field.name] = text;
	}
	return args;
};

const FieldInput = ({
	field,
	value,
	onChange,
}: {
	field: ToolField;
	value: string;
	onChange: (value: string) => void;
}) => {
	const inputId = `tester-field-${field.name}`;
	return (
		<div className="space-y-1">
			<div className="font-medium">
				<label htmlFor={inputId}>{field.name}</label>
				{field.required ? <span className="text-rose-300"> *</span> : null}
			</div>
			{field.description ? (
				<p className="text-muted-foreground">{field.description}</p>
			) : null}
			{field.kind === 'boolean' || field.kind === 'enum' ? (
				<select
					id={inputId}
					value={value}
					onChange={(event) => onChange(event.target.value)}
					className={INPUT_CLASS}
				>
					<option value="">—</option>
					{field.kind === 'boolean' ? (
						<>
							<option value="true">{t('tester.boolean.true')}</option>
							<option value="false">{t('tester.boolean.false')}</option>
						</>
					) : (
						field.enumOptions?.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))
					)}
				</select>
			) : null}
			{field.kind === 'string' ||
			field.kind === 'number' ||
			field.kind === 'integer' ? (
				<input
					id={inputId}
					type={field.kind === 'string' ? 'text' : 'number'}
					step={field.kind === 'integer' ? '1' : 'any'}
					value={value}
					onChange={(event) => onChange(event.target.value)}
					className={INPUT_CLASS}
				/>
			) : null}
			{field.kind === 'json' ? (
				<textarea
					id={inputId}
					value={value}
					onChange={(event) => onChange(event.target.value)}
					rows={4}
					spellCheck={false}
					className={`${INPUT_CLASS} font-mono`}
				/>
			) : null}
		</div>
	);
};

const Select = ({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: string;
	options: {
		value: string;
		label: string;
	}[];
	onChange: (value: string) => void;
}) => (
	<label className="space-y-1">
		<span className="font-medium">{label}</span>
		<select
			value={value}
			onChange={(event) => onChange(event.target.value)}
			className={INPUT_CLASS}
			disabled={options.length === 0}
		>
			{options.length === 0 ? <option value="">—</option> : null}
			{options.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	</label>
);

const ExchangeSide = ({
	title,
	summary,
	headers,
	body,
}: {
	title: string;
	summary: string;
	headers: Record<string, string>;
	body: unknown;
}) => (
	<div className="min-w-0 space-y-2">
		<h3 className="font-semibold">{title}</h3>
		<p className="break-all font-mono">{summary}</p>
		<JsonPreview data={headers} />
		<JsonPreview data={body} />
	</div>
);

const TesterSection = ({ backends }: { backends: BackendOverview[] }) => {
	const [method, setMethod] = useState<Method>('server/discover');
	const [selectedBackend, setSelectedBackend] = useState('');
	const [selectedTool, setSelectedTool] = useState('');
	const [selectedPrompt, setSelectedPrompt] = useState('');
	const [uri, setUri] = useState('');
	const [cursor, setCursor] = useState('');
	const [completionArgument, setCompletionArgument] = useState('');
	const [completionValue, setCompletionValue] = useState('');
	const [values, setValues] = useState<Record<string, string>>({});
	const [requestId, setRequestId] = useState(1);
	const { pending, error, setError, run } = useRequest();
	const [exchange, setExchange] = useState<TesterResponse | null>(null);

	// Every known backend and item is offered, disabled or not permitted ones
	// too, so their errors can be tested.
	const backend =
		backends.find((entry) => entry.serverName === selectedBackend) ??
		backends[0];
	const tools = backend?.tools.tools ?? [];
	const tool: Tool | undefined =
		tools.find((entry) => entry.name === selectedTool) ?? tools[0];
	const prompts = backend?.prompts.prompts ?? [];
	const prompt =
		prompts.find((entry) => entry.name === selectedPrompt) ?? prompts[0];
	const promptArguments = prompt?.arguments ?? [];
	// The chosen argument while the prompt has it, else the prompt's first.
	const argumentName =
		promptArguments.find((argument) => argument.name === completionArgument)
			?.name ??
		promptArguments[0]?.name ??
		'';
	const fields = useMemo(() => getToolFields(tool), [tool]);
	const fieldKey = (name: string) =>
		JSON.stringify([
			method,
			backend?.serverName,
			tool?.name,
			prompt?.name,
			name,
		]);
	const fieldValue = (field: ToolField) =>
		values[fieldKey(field.name)] ?? field.defaultValue ?? '';
	const setFieldValue = (name: string, value: string) =>
		setValues((current) => ({
			...current,
			[fieldKey(name)]: value,
		}));
	const disabledMark = (enabled: boolean) =>
		enabled ? '' : ` (${t('list.disabled')})`;

	// The method's own params, or the reason they cannot be built.
	const methodParams = (): Record<string, unknown> | string => {
		if (LIST_METHODS.has(method))
			return cursor.trim()
				? {
						cursor: cursor.trim(),
					}
				: {};
		if (method === 'resources/read')
			return uri.trim()
				? {
						uri: uri.trim(),
					}
				: t('tester.uriRequired');
		if (method === 'tools/call') {
			if (!backend) return t('tester.noBackends');
			if (!tool) return t('list.empty.tools');
			const args = parseArguments(
				fields,
				Object.fromEntries(
					fields.map((field) => [field.name, fieldValue(field)]),
				),
			);
			return typeof args === 'string'
				? args
				: {
						name: addPrefix({
							serverName: backend.serverName,
							name: tool.name,
						}),
						arguments: args,
					};
		}
		if (method === 'prompts/get' || method === 'completion/complete') {
			if (!backend) return t('tester.noBackends');
			if (!prompt) return t('list.empty.prompts');
			const name = addPrefix({
				serverName: backend.serverName,
				name: prompt.name,
			});
			if (method === 'completion/complete')
				return {
					ref: {
						type: 'ref/prompt',
						name,
					},
					argument: {
						name: argumentName,
						value: completionValue,
					},
				};
			const args = Object.fromEntries(
				promptArguments
					.map((argument) => [argument.name, values[fieldKey(argument.name)]])
					.filter(([, value]) => value),
			);
			return {
				name,
				arguments: args,
			};
		}
		return {};
	};

	const onRun = async (event: SubmitEvent<HTMLFormElement>) => {
		event.preventDefault();
		const built = methodParams();
		if (typeof built === 'string') {
			setError(built);
			return;
		}
		const params = {
			...built,
			_meta: {
				[PROTOCOL_VERSION_META]: CURRENT_PROTOCOL_VERSION,
				[CLIENT_CAPABILITIES_META]: {},
				[CLIENT_INFO_META]: TESTER_CLIENT_INFO,
			},
		};
		const headerParameters =
			method === 'tools/call' && tool
				? toolHeaderParameters(tool.inputSchema)
				: [];
		let headers: Headers;
		try {
			headers = protocolHeaders(
				method,
				params,
				headerParameters instanceof Error ? [] : headerParameters,
			);
		} catch (err) {
			setError(errorMessage(err));
			return;
		}
		headers.set('Content-Type', 'application/json');
		headers.set('Accept', 'application/json, text/event-stream');
		await run(async () => {
			setExchange(
				testerResponseType.assert(
					await postJson(TESTER_PATH, {
						headers: Object.fromEntries(headers),
						body: {
							jsonrpc: '2.0',
							id: requestId,
							method,
							params,
						},
					}),
				),
			);
			setRequestId((id) => id + 1);
		});
	};

	const usesBackend =
		method === 'tools/call' ||
		method === 'prompts/get' ||
		method === 'completion/complete' ||
		method === 'resources/read';

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t('tester.title')}</CardTitle>
				<CardDescription>
					{t('tester.subtitle')} {CURRENT_PROTOCOL_VERSION}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<form className="space-y-3" onSubmit={(event) => void onRun(event)}>
					<div className="grid gap-3 sm:grid-cols-3">
						<Select
							label={t('tester.method')}
							value={method}
							options={METHODS.map((entry) => ({
								value: entry,
								label: entry,
							}))}
							onChange={(value) =>
								setMethod(METHODS.find((entry) => entry === value) ?? method)
							}
						/>
						{usesBackend ? (
							<Select
								label={t('tester.backend')}
								value={backend?.serverName ?? ''}
								options={backends.map((entry) => ({
									value: entry.serverName,
									label: entry.serverName + disabledMark(entry.enabled),
								}))}
								onChange={setSelectedBackend}
							/>
						) : null}
						{method === 'tools/call' ? (
							<Select
								label={t('tester.tool')}
								value={tool?.name ?? ''}
								options={tools.map((entry) => ({
									value: entry.name,
									label:
										entry.name +
										disabledMark(
											backend?.enabledTools.includes(entry.name) ?? false,
										),
								}))}
								onChange={setSelectedTool}
							/>
						) : null}
						{method === 'prompts/get' || method === 'completion/complete' ? (
							<Select
								label={t('tester.prompt')}
								value={prompt?.name ?? ''}
								options={prompts.map((entry) => ({
									value: entry.name,
									label: entry.name,
								}))}
								onChange={setSelectedPrompt}
							/>
						) : null}
						{method === 'resources/read' ? (
							<Select
								label={t('tester.resource')}
								value=""
								options={[
									{
										value: '',
										label: '—',
									},
									...(backend?.resources.resources ?? []).map((entry) => ({
										value: addResourcePrefix({
											serverName: backend?.serverName ?? '',
											uri: entry.uri,
										}),
										label: entry.name ?? entry.uri,
									})),
								]}
								onChange={(value) => value && setUri(value)}
							/>
						) : null}
					</div>

					{LIST_METHODS.has(method) ? (
						<label className="block space-y-1">
							<span className="font-medium">{t('tester.cursor')}</span>
							<input
								value={cursor}
								onChange={(event) => setCursor(event.target.value)}
								className={INPUT_CLASS}
							/>
						</label>
					) : null}
					{method === 'resources/read' ? (
						<label className="block space-y-1">
							<span className="font-medium">{t('tester.uri')}</span>
							<input
								value={uri}
								onChange={(event) => setUri(event.target.value)}
								className={`${INPUT_CLASS} font-mono`}
							/>
						</label>
					) : null}
					{method === 'tools/call' ? (
						<>
							{tool?.description ? (
								<p className="text-muted-foreground">{tool.description}</p>
							) : null}
							{fields.map((field) => (
								<FieldInput
									key={field.name}
									field={field}
									value={fieldValue(field)}
									onChange={(value) => setFieldValue(field.name, value)}
								/>
							))}
						</>
					) : null}
					{method === 'prompts/get'
						? promptArguments.map((argument) => (
								<FieldInput
									key={argument.name}
									field={{
										name: argument.name,
										required: argument.required ?? false,
										kind: 'string',
										description: argument.description,
									}}
									value={values[fieldKey(argument.name)] ?? ''}
									onChange={(value) => setFieldValue(argument.name, value)}
								/>
							))
						: null}
					{method === 'completion/complete' ? (
						<div className="grid gap-3 sm:grid-cols-2">
							<Select
								label={t('tester.argument')}
								value={argumentName}
								options={promptArguments.map((argument) => ({
									value: argument.name,
									label: argument.name,
								}))}
								onChange={setCompletionArgument}
							/>
							<label className="space-y-1">
								<span className="font-medium">{t('tester.value')}</span>
								<input
									value={completionValue}
									onChange={(event) => setCompletionValue(event.target.value)}
									className={INPUT_CLASS}
								/>
							</label>
						</div>
					) : null}

					<div className="flex items-center gap-3">
						<Button type="submit" disabled={pending}>
							{pending ? t('tester.running') : t('tester.run')}
						</Button>
						{error ? <p className="break-all text-rose-300">{error}</p> : null}
					</div>
				</form>

				{exchange ? (
					<div className="grid items-start gap-4 lg:grid-cols-2">
						<ExchangeSide
							title={t('tester.request')}
							summary={`${exchange.request.method} ${exchange.request.url}`}
							headers={exchange.request.headers}
							body={exchange.request.body}
						/>
						<ExchangeSide
							title={t('tester.response')}
							summary={`HTTP ${exchange.response.status}`}
							headers={exchange.response.headers}
							body={exchange.response.body}
						/>
					</div>
				) : null}
			</CardContent>
		</Card>
	);
};

export { TesterSection };
