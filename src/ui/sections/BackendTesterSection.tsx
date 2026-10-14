import { type SubmitEvent, useEffect, useMemo, useState } from 'react';

import { errorMessage } from '@/shared/common';
import type { BackendOverview, Tool } from '@/shared/ui_api';
import { postJson } from '@/ui/api/client';
import { Button } from '@/ui/base_components/button';
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@/ui/base_components/card';
import { JsonPreview } from '@/ui/components/JsonPreview';
import { t } from '@/ui/i18n';

type FieldKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'json';

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

type Props = {
	backends: BackendOverview[];
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
			const enumOptions = enumRaw.map((item: unknown) => ({
				value: JSON.stringify(item),
				label: typeof item === 'string' ? item : JSON.stringify(item),
			}));
			fields.push({
				name,
				required: required.has(name),
				kind: 'enum',
				description,
				enumOptions,
				defaultValue:
					property.default === undefined
						? enumOptions[0]?.value
						: JSON.stringify(property.default),
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
		if (
			typeName === 'string' &&
			!('anyOf' in property) &&
			!('oneOf' in property)
		) {
			fields.push({
				name,
				required: required.has(name),
				kind: 'string',
				description,
				defaultValue,
			});
			continue;
		}
		fields.push({
			name,
			required: required.has(name),
			kind: 'json',
			description,
			defaultValue:
				property.default === undefined
					? undefined
					: JSON.stringify(property.default, null, 2),
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
	const enabledBackends = backends.filter((backend) => backend.enabled);
	const currentBackend =
		enabledBackends.find((backend) => backend.serverName === selectedBackend) ??
		enabledBackends[0] ??
		null;
	const tools = (currentBackend?.tools.tools ?? []).filter((item) =>
		currentBackend?.enabledTools.includes(item.name),
	);
	const tool =
		tools.find((item) => item.name === selectedTool) ?? tools[0] ?? null;
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
			if (field.kind === 'enum' || field.kind === 'json') {
				try {
					args[field.name] = JSON.parse(text);
				} catch {
					setRunError(`Field "${field.name}" must be valid JSON.`);
					return;
				}
				continue;
			}
			args[field.name] = text;
		}

		setRunning(true);
		setRunError(null);
		setResult(null);
		try {
			const payload = (await postJson('/api/tools/call', {
				serverName: currentBackend.serverName,
				toolName: tool.name,
				arguments: args,
			})) as {
				result?: unknown;
			};
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
				{enabledBackends.length === 0 ? (
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
									value={currentBackend?.serverName ?? ''}
									onChange={(event) => setSelectedBackend(event.target.value)}
									className="w-full rounded-md border bg-background px-3 py-2 text-sm"
								>
									{enabledBackends.map((backend) => (
										<option key={backend.serverName} value={backend.serverName}>
											{backend.serverName}
										</option>
									))}
								</select>
							</label>
							<label className="space-y-1">
								<span className="text-sm font-medium">{t('tester.tool')}</span>
								<select
									value={tool?.name ?? ''}
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
													{field.enumOptions?.map((option) => (
														<option key={option.value} value={option.value}>
															{option.label}
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
											{field.kind === 'json' ? (
												<textarea
													id={inputId}
													value={values[field.name] ?? ''}
													onChange={(event) =>
														updateValue(field.name, event.target.value)
													}
													rows={4}
													spellCheck={false}
													className="w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
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
