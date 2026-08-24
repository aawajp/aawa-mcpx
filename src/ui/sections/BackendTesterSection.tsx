import { type SubmitEvent, useEffect, useMemo, useState } from 'react';

import { t } from '@/ui/i18n';
import type { McpUpstreamStatus, Tool } from '@/shared/ui_api';
import { JsonPreview } from '@/ui/components/JsonPreview';
import { Button } from '@/ui/base_components/button';
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@/ui/base_components/card';
import { errorMessage } from '@/shared/common';

type FieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum';

type ToolField = {
	name: string;
	required: boolean;
	kind: FieldKind;
	description?: string;
	enumValues?: string[];
	defaultValue?: string;
};

type Props = {
	backends: McpUpstreamStatus[];
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
};

const getSchemaType = (value: unknown): string | undefined => {
	if (typeof value === 'string') return value;
	if (!Array.isArray(value)) return undefined;
	const typeValue = value.find((item) => typeof item === 'string');
	return typeof typeValue === 'string' ? typeValue : undefined;
};

const toDefault = (value: unknown): string | undefined => {
	if (value === undefined || value === null) return undefined;
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	return undefined;
};

const getToolFields = (tool: Tool | null): ToolField[] => {
	if (!tool) return [];
	const schema = asRecord(tool.inputSchema);
	if (!schema) return [];
	const properties = asRecord(schema.properties);
	if (!properties) return [];
	const requiredRaw = Array.isArray(schema.required) ? schema.required : [];
	const required = new Set(
		requiredRaw
			.filter((item) => typeof item === 'string')
			.map((item) => item as string),
	);

	const fields: ToolField[] = [];
	for (const [name, rawProperty] of Object.entries(properties)) {
		const property = asRecord(rawProperty);
		if (!property) continue;
		const description =
			typeof property.description === 'string'
				? property.description
				: undefined;
		const defaultValue = toDefault(property.default);
		const enumRaw = Array.isArray(property.enum) ? property.enum : null;
		if (enumRaw && enumRaw.length > 0) {
			const enumValues = enumRaw.map((item) => String(item));
			fields.push({
				name,
				required: required.has(name),
				kind: 'enum',
				description,
				enumValues,
				defaultValue: defaultValue ?? enumValues[0],
			});
			continue;
		}

		const typeName = getSchemaType(property.type);
		if (typeName === 'boolean') {
			fields.push({
				name,
				required: required.has(name),
				kind: 'boolean',
				description,
				defaultValue:
					defaultValue === 'true' || defaultValue === 'false'
						? defaultValue
						: undefined,
			});
			continue;
		}
		if (typeName === 'number') {
			fields.push({
				name,
				required: required.has(name),
				kind: 'number',
				description,
				defaultValue,
			});
			continue;
		}
		if (typeName === 'integer') {
			fields.push({
				name,
				required: required.has(name),
				kind: 'integer',
				description,
				defaultValue,
			});
			continue;
		}
		fields.push({
			name,
			required: required.has(name),
			kind: 'string',
			description,
			defaultValue,
		});
	}

	return fields;
};

const BackendTesterSection = ({ backends }: Props) => {
	const [selectedBackend, setSelectedBackend] = useState('');
	const [selectedTool, setSelectedTool] = useState('');
	const [values, setValues] = useState<Record<string, string>>({});
	const [running, setRunning] = useState(false);
	const [runError, setRunError] = useState<string | null>(null);
	const [result, setResult] = useState<unknown>(null);
	const sortedBackends = useMemo(() => {
		return backends
			.filter((backend) => backend.enabled)
			.sort((a, b) =>
				a.serverName.localeCompare(b.serverName, undefined, {
					sensitivity: 'base',
				}),
			);
	}, [backends]);

	useEffect(() => {
		if (sortedBackends.length === 0) {
			setSelectedBackend('');
			return;
		}
		const exists = sortedBackends.some(
			(backend) => backend.serverName === selectedBackend,
		);
		if (!exists) {
			setSelectedBackend(sortedBackends[0]?.serverName ?? '');
		}
	}, [sortedBackends, selectedBackend]);

	const currentBackend =
		sortedBackends.find((backend) => backend.serverName === selectedBackend) ??
		null;
	const tools = useMemo(() => {
		const backendTools = currentBackend?.tools.tools ?? [];
		return [...backendTools].sort((a, b) =>
			a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
		);
	}, [currentBackend]);

	useEffect(() => {
		if (tools.length === 0) {
			setSelectedTool('');
			return;
		}
		const exists = tools.some((tool) => tool.name === selectedTool);
		if (!exists) {
			setSelectedTool(tools[0]?.name ?? '');
		}
	}, [tools, selectedTool]);

	const tool = tools.find((item) => item.name === selectedTool) ?? null;
	const fields = useMemo(() => getToolFields(tool), [tool]);

	useEffect(() => {
		setValues((current) => {
			const next: Record<string, string> = {};
			fields.forEach((field) => {
				const existing = current[field.name];
				if (existing !== undefined) {
					next[field.name] = existing;
					return;
				}
				if (field.defaultValue !== undefined) {
					next[field.name] = field.defaultValue;
					return;
				}
				next[field.name] = '';
			});
			return next;
		});
	}, [fields]);

	const updateValue = (name: string, value: string) => {
		setValues((current) => ({
			...current,
			[name]: value,
		}));
	};

	const onRun = async (event: SubmitEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!currentBackend || !tool) {
			setRunError('Select backend and tool.');
			return;
		}

		const args: Record<string, unknown> = {};
		for (const field of fields) {
			const raw = values[field.name] ?? '';
			if (field.kind === 'boolean') {
				if (raw === '') {
					if (field.required) {
						setRunError(`Field "${field.name}" is required.`);
						return;
					}
					continue;
				}
				args[field.name] = raw === 'true';
				continue;
			}

			const text = raw.trim();
			if (text === '') {
				if (field.required) {
					setRunError(`Field "${field.name}" is required.`);
					return;
				}
				continue;
			}
			if (field.kind === 'number') {
				const numberValue = Number(text);
				if (Number.isNaN(numberValue)) {
					setRunError(`Field "${field.name}" must be a number.`);
					return;
				}
				args[field.name] = numberValue;
				continue;
			}
			if (field.kind === 'integer') {
				const numberValue = Number(text);
				if (Number.isNaN(numberValue) || !Number.isInteger(numberValue)) {
					setRunError(`Field "${field.name}" must be an integer.`);
					return;
				}
				args[field.name] = numberValue;
				continue;
			}
			args[field.name] = text;
		}

		setRunning(true);
		setRunError(null);
		setResult(null);
		try {
			const response = await fetch('/api/tools/call', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					serverName: currentBackend.serverName,
					toolName: tool.name,
					arguments: args,
				}),
			});
			if (!response.ok) {
				throw new Error(`Request failed with status ${response.status}`);
			}
			const payload = (await response.json()) as { result?: unknown };
			setResult(payload.result ?? null);
		} catch (err) {
			setRunError(errorMessage(err));
		} finally {
			setRunning(false);
		}
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle>{t('tester.title')}</CardTitle>
				<CardDescription>{t('tester.subtitle')}</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{sortedBackends.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						{t('tester.noBackends')}
					</p>
				) : (
					<form className="space-y-4" onSubmit={(event) => void onRun(event)}>
						<div className="grid gap-3 sm:grid-cols-2">
							<label className="space-y-1">
								<span className="text-sm font-medium">
									{t('tester.backend')}
								</span>
								<select
									value={selectedBackend}
									onChange={(event) => setSelectedBackend(event.target.value)}
									className="w-full rounded-md border bg-background px-3 py-2 text-sm"
								>
									{sortedBackends.map((backend) => (
										<option key={backend.serverName} value={backend.serverName}>
											{backend.serverName}
										</option>
									))}
								</select>
							</label>
							<label className="space-y-1">
								<span className="text-sm font-medium">{t('tester.tool')}</span>
								<select
									value={selectedTool}
									onChange={(event) => setSelectedTool(event.target.value)}
									className="w-full rounded-md border bg-background px-3 py-2 text-sm"
									disabled={tools.length === 0}
								>
									{tools.length === 0 ? (
										<option value="">{t('tester.noTools')}</option>
									) : (
										tools.map((item) => (
											<option key={item.name} value={item.name}>
												{item.name}
											</option>
										))
									)}
								</select>
							</label>
						</div>

						{tool?.description ? (
							<p className="text-sm text-muted-foreground">
								{tool.description}
							</p>
						) : null}

						<div className="space-y-3">
							{fields.length === 0 ? (
								<p className="text-sm text-muted-foreground">
									{t('tester.noParameters')}
								</p>
							) : (
								fields.map((field) => {
									const inputId = `tester-field-${field.name}`;
									return (
										<div className="space-y-1 block" key={field.name}>
											<div className="text-sm font-medium">
												<label htmlFor={inputId}>{field.name}</label>
												{field.required ? (
													<span className="text-rose-300"> *</span>
												) : null}
											</div>
											{field.description ? (
												<p className="text-xs text-muted-foreground">
													{field.description}
												</p>
											) : null}
											{field.kind === 'boolean' ? (
												<select
													id={inputId}
													value={values[field.name] ?? ''}
													onChange={(event) =>
														updateValue(field.name, event.target.value)
													}
													className="w-full rounded-md border bg-background px-3 py-2 text-sm"
												>
													<option value="">—</option>
													<option value="true">
														{t('tester.boolean.true')}
													</option>
													<option value="false">
														{t('tester.boolean.false')}
													</option>
												</select>
											) : null}
											{field.kind === 'enum' ? (
												<select
													id={inputId}
													value={values[field.name] ?? ''}
													onChange={(event) =>
														updateValue(field.name, event.target.value)
													}
													className="w-full rounded-md border bg-background px-3 py-2 text-sm"
												>
													<option value="">—</option>
													{field.enumValues?.map((value) => (
														<option key={value} value={value}>
															{value}
														</option>
													))}
												</select>
											) : null}
											{field.kind === 'string' ||
											field.kind === 'number' ||
											field.kind === 'integer' ? (
												<input
													id={inputId}
													type={field.kind === 'string' ? 'text' : 'number'}
													step={field.kind === 'integer' ? '1' : 'any'}
													value={values[field.name] ?? ''}
													onChange={(event) =>
														updateValue(field.name, event.target.value)
													}
													className="w-full rounded-md border bg-background px-3 py-2 text-sm"
												/>
											) : null}
										</div>
									);
								})
							)}
						</div>

						<div className="flex items-center gap-3">
							<Button type="submit" disabled={running || !tool}>
								{running ? t('tester.running') : t('tester.run')}
							</Button>
							{runError ? (
								<p className="text-sm text-rose-300 break-all">{runError}</p>
							) : null}
						</div>
					</form>
				)}

				{result !== null ? (
					<div className="space-y-2">
						<h3 className="text-sm font-semibold">{t('tester.result')}</h3>
						<JsonPreview data={result} />
					</div>
				) : null}
			</CardContent>
		</Card>
	);
};

export { BackendTesterSection };
