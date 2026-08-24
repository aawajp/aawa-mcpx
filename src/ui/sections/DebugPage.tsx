import { useCallback, useEffect, useMemo, useState } from 'react';

import { t } from '@/ui/i18n';
import {
	backendTrafficResponseType,
	debugSummaryResponseType,
	type TrafficPage,
	type TrafficRecord,
	trafficPageType,
} from '@/shared/ui_api';
import { JsonPreview } from '@/ui/components/JsonPreview';
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@/ui/base_components/card';
import { errorMessage } from '@/shared/common';

type BackendEntry = {
	name: string;
	page: number;
	data?: TrafficPage;
	methodFilter: string;
	errorsOnly: boolean;
};

type TrafficEventType = 'success' | 'error' | 'validation';

const getRelatedMethod = (record: TrafficRecord): string => {
	if (record.relatedMethod) return record.relatedMethod;
	if (record.method) return record.method;
	return '—';
};

const getEventType = (record: TrafficRecord): TrafficEventType => {
	if (record.eventType === 'validation_error') {
		return 'validation';
	}
	if (record.eventType === 'error') {
		return 'error';
	}
	return 'success';
};

const TrafficTable = ({ records }: { records: TrafficRecord[] }) => {
	if (!records.length) {
		return (
			<p className="text-sm text-muted-foreground">{t('debug.table.empty')}</p>
		);
	}

	return (
		<div className="space-y-3">
			{records.map((record) => (
				<div key={record.id} className="rounded-lg border p-4 space-y-3">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm min-w-0">
							<div className="text-muted-foreground">
								{new Date(record.createdAt).toLocaleString()}
							</div>
							<div className="font-medium min-w-40 flex-1 truncate">
								{record.peer}
							</div>
							<div>
								{getEventType(record) === 'validation' ? (
									<span className="rounded border border-amber-300/35 bg-amber-500/15 px-2 py-1 text-amber-200 text-xs">
										{t('traffic.type.validation')}
									</span>
								) : null}
								{getEventType(record) === 'error' ? (
									<span className="rounded border border-rose-400/35 bg-rose-500/15 px-2 py-1 text-rose-200 text-xs">
										{t('traffic.type.error')}
									</span>
								) : null}
								{getEventType(record) === 'success' ? (
									<span className="rounded border border-emerald-400/35 bg-emerald-500/15 px-2 py-1 text-emerald-200 text-xs">
										{t('traffic.type.success')}
									</span>
								) : null}
							</div>
						</div>
						<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
							<span>
								{t('traffic.header.related')}: {getRelatedMethod(record)}
							</span>
							<span>
								{t('traffic.header.method')}: {record.method ?? '—'}
							</span>
						</div>
					</div>

					<div className="grid gap-3 2xl:grid-cols-2">
						<div className="space-y-2">
							<div className="text-xs font-medium text-muted-foreground">
								{t('traffic.header.request')}
							</div>
							<JsonPreview data={record.request} />
						</div>
						<div className="space-y-2">
							<div className="text-xs font-medium text-muted-foreground">
								{t('traffic.header.response')}
							</div>
							<JsonPreview data={record.response} />
						</div>
					</div>
				</div>
			))}
		</div>
	);
};

const PaginationControls = ({
	page,
	limit,
	total,
	onPageChange,
}: {
	page: number;
	limit: number;
	total: number;
	onPageChange: (page: number) => void;
}) => {
	const totalPages = Math.max(1, Math.ceil(total / limit));
	return (
		<div className="flex items-center gap-2 text-xs text-muted-foreground">
			<button
				type="button"
				onClick={() => onPageChange(Math.max(0, page - 1))}
				className="rounded border px-2 py-1"
				disabled={page === 0}
			>
				{t('pagination.prev')}
			</button>
			<span>
				{t('pagination.page')} {page + 1} / {totalPages}
			</span>
			<button
				type="button"
				onClick={() => onPageChange(Math.min(totalPages - 1, page + 1))}
				className="rounded border px-2 py-1"
				disabled={page + 1 >= totalPages}
			>
				{t('pagination.next')}
			</button>
		</div>
	);
};

const filterButtonClass = (active: boolean): string => {
	return `inline-flex h-8 items-center rounded-md border px-3 py-1 text-xs font-medium transition ${
		active
			? 'bg-muted border-foreground text-foreground'
			: 'text-muted-foreground hover:bg-muted'
	}`;
};

type DebugPageProps = {
	onNavigate: (route: 'main') => void;
};

const DebugPage = ({ onNavigate }: DebugPageProps) => {
	const [debugClient, setDebugClient] = useState<TrafficPage | null>(null);
	const [clientErrorsOnly, setClientErrorsOnly] = useState(false);
	const [clientPage, setClientPage] = useState(0);
	const [backendEntries, setBackendEntries] = useState<
		Record<string, BackendEntry>
	>({});
	const [debugError, setDebugError] = useState<string | null>(null);
	const debugLimit = 20;

	const loadDebugSummary = useCallback(async () => {
		try {
			setDebugError(null);
			const res = await fetch('/api/debug', { cache: 'no-store' });
			if (!res.ok) {
				throw new Error(`Debug request failed with status ${res.status}`);
			}
			const data = debugSummaryResponseType.assert(await res.json());
			setDebugClient(data.client);
			const nextEntries: Record<string, BackendEntry> = {};
			data.backends.forEach((entry) => {
				nextEntries[entry.backend] = {
					name: entry.backend,
					page: 0,
					data: entry.data,
					methodFilter: '',
					errorsOnly: false,
				};
			});
			setBackendEntries(nextEntries);
			setClientPage(0);
			setClientErrorsOnly(false);
		} catch (err) {
			setDebugError(errorMessage(err));
		}
	}, []);

	useEffect(() => {
		void loadDebugSummary();
	}, [loadDebugSummary]);

	const loadClientPage = useCallback(
		async (page: number, errorsOnly: boolean) => {
			try {
				const offset = page * debugLimit;
				const errorsOnlyParam = errorsOnly ? '&errorsOnly=1' : '';
				const res = await fetch(
					`/api/debug/client?limit=${debugLimit}&offset=${offset}${errorsOnlyParam}`,
					{ cache: 'no-store' },
				);
				if (!res.ok) {
					throw new Error(`Client debug fetch failed (${res.status})`);
				}
				const data = trafficPageType.assert(await res.json());
				setDebugClient(data);
				setClientPage(page);
			} catch (err) {
				setDebugError(errorMessage(err));
			}
		},
		[],
	);

	const loadBackendPage = useCallback(
		async (
			backend: string,
			page: number,
			method?: string,
			errorsOnly?: boolean,
		) => {
			try {
				const offset = page * debugLimit;
				const methodParam =
					method && method.trim() !== ''
						? `&method=${encodeURIComponent(method)}`
						: '';
				const errorsOnlyParam = errorsOnly ? '&errorsOnly=1' : '';
				const res = await fetch(
					`/api/debug/backend?backend=${encodeURIComponent(backend)}&limit=${debugLimit}&offset=${offset}${methodParam}${errorsOnlyParam}`,
					{ cache: 'no-store' },
				);
				if (!res.ok) {
					throw new Error(
						`Backend debug fetch failed for ${backend} (${res.status})`,
					);
				}
				const data = backendTrafficResponseType.assert(await res.json());
				setBackendEntries((current) => ({
					...current,
					[backend]: {
						...(current[backend] ?? {
							name: backend,
							page,
							methodFilter: method ?? '',
						}),
						page,
						data: {
							records: data.records,
							total: data.total,
						},
						errorsOnly: errorsOnly ?? false,
					},
				}));
			} catch (err) {
				setDebugError(errorMessage(err));
			}
		},
		[],
	);

	const backendList = useMemo(
		() =>
			Object.values(backendEntries).sort((a, b) =>
				a.name.localeCompare(b.name),
			),
		[backendEntries],
	);

	return (
		<div className="app-shell container mx-auto max-w-[1600px] p-6 space-y-6">
			<header className="space-y-2">
				<div>
					<h1 className="text-3xl font-bold">{t('debug.title')}</h1>
					<p className="text-muted-foreground">{t('debug.client.subtitle')}</p>
				</div>
			</header>

			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={() => onNavigate('main')}
					className="inline-flex items-center rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted transition"
				>
					{t('debug.back')}
				</button>
				<button
					type="button"
					onClick={() => void loadDebugSummary()}
					className="inline-flex items-center rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted transition"
				>
					{t('debug.refresh')}
				</button>
				{debugError ? (
					<span className="text-xs text-rose-300">{debugError}</span>
				) : null}
			</div>

			<div className="grid gap-6 xl:grid-cols-12">
				<Card className="xl:col-span-8">
					<CardHeader>
						<div className="flex flex-wrap items-start justify-between gap-3">
							<div>
								<CardTitle>{t('debug.client.title')}</CardTitle>
								<CardDescription>{t('debug.client.subtitle')}</CardDescription>
							</div>
							<div className="flex items-center gap-2">
								<button
									type="button"
									onClick={() => {
										setClientErrorsOnly(false);
										void loadClientPage(0, false);
									}}
									className={filterButtonClass(!clientErrorsOnly)}
								>
									{t('debug.showAll')}
								</button>
								<button
									type="button"
									onClick={() => {
										setClientErrorsOnly(true);
										void loadClientPage(0, true);
									}}
									className={filterButtonClass(clientErrorsOnly)}
								>
									{t('debug.errorsOnly')}
								</button>
							</div>
						</div>
					</CardHeader>
					<CardContent className="space-y-3">
						<TrafficTable records={debugClient?.records ?? []} />
						<PaginationControls
							page={clientPage}
							limit={debugLimit}
							total={debugClient?.total ?? 0}
							onPageChange={(page) =>
								void loadClientPage(page, clientErrorsOnly)
							}
						/>
					</CardContent>
				</Card>

				<Card className="xl:col-span-4">
					<CardHeader>
						<CardTitle>{t('debug.backend.title')}</CardTitle>
						<CardDescription>{t('debug.backend.subtitle')}</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						{backendList.map((entry) => (
							<div key={entry.name} className="rounded-lg border p-4 space-y-3">
								<div className="space-y-1">
									<h3 className="backend-name backend-name-strong text-lg break-all">
										{entry.name}
									</h3>
									<p className="text-xs text-muted-foreground break-all">
										{t('debug.gatewayPrefix')} {entry.name}
									</p>
								</div>
								<div className="flex flex-wrap items-center gap-2">
									<input
										type="text"
										value={entry.methodFilter}
										onChange={(e) =>
											setBackendEntries((current) => ({
												...current,
												[entry.name]: {
													...(current[entry.name] ?? entry),
													methodFilter: e.target.value,
												},
											}))
										}
										placeholder={t('debug.method.placeholder')}
										className="h-8 min-w-56 flex-1 rounded border px-2 py-1 text-xs"
									/>
									<button
										type="button"
										onClick={() =>
											void loadBackendPage(
												entry.name,
												0,
												entry.methodFilter,
												entry.errorsOnly,
											)
										}
										className="inline-flex h-8 items-center rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted transition"
									>
										{t('backends.refresh')}
									</button>
									<button
										type="button"
										onClick={() => {
											setBackendEntries((current) => ({
												...current,
												[entry.name]: {
													...(current[entry.name] ?? entry),
													errorsOnly: false,
													page: 0,
												},
											}));
											void loadBackendPage(
												entry.name,
												0,
												entry.methodFilter,
												false,
											);
										}}
										className={filterButtonClass(!entry.errorsOnly)}
									>
										{t('debug.showAll')}
									</button>
									<button
										type="button"
										onClick={() => {
											setBackendEntries((current) => ({
												...current,
												[entry.name]: {
													...(current[entry.name] ?? entry),
													errorsOnly: true,
													page: 0,
												},
											}));
											void loadBackendPage(
												entry.name,
												0,
												entry.methodFilter,
												true,
											);
										}}
										className={filterButtonClass(entry.errorsOnly)}
									>
										{t('debug.errorsOnly')}
									</button>
								</div>
								<div className="space-y-3">
									<TrafficTable records={entry.data?.records ?? []} />
									<PaginationControls
										page={entry.page}
										limit={debugLimit}
										total={entry.data?.total ?? 0}
										onPageChange={(next) =>
											void loadBackendPage(
												entry.name,
												next,
												entry.methodFilter,
												entry.errorsOnly,
											)
										}
									/>
								</div>
							</div>
						))}
					</CardContent>
				</Card>
			</div>
		</div>
	);
};

export { DebugPage };
