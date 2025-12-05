import { useCallback, useEffect, useMemo, useState } from 'react';

import { t } from '@/i18n';
import type { TrafficPage } from '@/types/overview';
import { JsonPreview } from '@/ui/components/JsonPreview';
import { Button } from '@/ui/shadcn/button';
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@/ui/shadcn/card';

type TrafficRecord = {
	id: number;
	peer: string;
	method?: string;
	request: unknown;
	response: unknown;
	createdAt: number;
};

type BackendEntry = {
	name: string;
	page: number;
	data?: TrafficPage;
	methodFilter: string;
};

type SummaryResponse = {
	client: TrafficPage;
	backends: Array<{ backend: string; data: TrafficPage }>;
};

const TrafficTable = ({ records }: { records: TrafficRecord[] }) => {
	if (!records.length) {
		return (
			<p className="text-sm text-muted-foreground">{t('debug.table.empty')}</p>
		);
	}

	return (
		<div className="overflow-auto">
			<table className="min-w-full text-sm">
				<thead className="text-xs text-muted-foreground">
					<tr>
						<th className="py-2 pr-3 text-left">{t('traffic.header.time')}</th>
						<th className="py-2 pr-3 text-left">{t('traffic.header.peer')}</th>
						<th className="py-2 pr-3 text-left">
							{t('traffic.header.method')}
						</th>
						<th className="py-2 pr-3 text-left">
							{t('traffic.header.request')}
						</th>
						<th className="py-2 pr-3 text-left">
							{t('traffic.header.response')}
						</th>
					</tr>
				</thead>
				<tbody className="align-top">
					{records.map((record) => (
						<tr key={record.id} className="border-t">
							<td className="py-2 pr-3 whitespace-nowrap">
								{new Date(record.createdAt).toLocaleString()}
							</td>
							<td className="py-2 pr-3 whitespace-nowrap">{record.peer}</td>
							<td className="py-2 pr-3 whitespace-nowrap">
								{record.method ?? '—'}
							</td>
							<td className="py-2 pr-3 min-w-[200px] max-w-[320px]">
								<JsonPreview data={record.request} />
							</td>
							<td className="py-2 pr-3 min-w-[200px] max-w-[320px]">
								<JsonPreview data={record.response} />
							</td>
						</tr>
					))}
				</tbody>
			</table>
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

type DebugPageProps = {
	onNavigate: (route: 'main') => void;
};

const DebugPage = ({ onNavigate }: DebugPageProps) => {
	const [debugClient, setDebugClient] = useState<TrafficPage | null>(null);
	const [clientPage, setClientPage] = useState(0);
	const [backendEntries, setBackendEntries] = useState<
		Record<string, BackendEntry>
	>({});
	const [debugError, setDebugError] = useState<string | null>(null);
	const debugLimit = 20;

	const loadDebugSummary = useCallback(async () => {
		try {
			setDebugError(null);
			const res = await fetch('/debug');
			if (!res.ok) {
				throw new Error(`Debug request failed with status ${res.status}`);
			}
			const data = (await res.json()) as SummaryResponse;
			setDebugClient(data.client);
			const nextEntries: Record<string, BackendEntry> = {};
			data.backends.forEach((entry) => {
				nextEntries[entry.backend] = {
					name: entry.backend,
					page: 0,
					data: entry.data,
					methodFilter: '',
				};
			});
			setBackendEntries(nextEntries);
			setClientPage(0);
		} catch (err) {
			setDebugError((err as Error).message);
		}
	}, []);

	useEffect(() => {
		void loadDebugSummary();
	}, [loadDebugSummary]);

	const loadClientPage = useCallback(async (page: number) => {
		try {
			const offset = page * debugLimit;
			const res = await fetch(
				`/debug/client?limit=${debugLimit}&offset=${offset}`,
			);
			if (!res.ok) {
				throw new Error(`Client debug fetch failed (${res.status})`);
			}
			const data = (await res.json()) as TrafficPage;
			setDebugClient(data);
			setClientPage(page);
		} catch (err) {
			setDebugError((err as Error).message);
		}
	}, []);

	const loadBackendPage = useCallback(
		async (backend: string, page: number, method?: string) => {
			try {
				const offset = page * debugLimit;
				const methodParam =
					method && method.trim() !== ''
						? `&method=${encodeURIComponent(method)}`
						: '';
				const res = await fetch(
					`/debug/backend?backend=${encodeURIComponent(backend)}&limit=${debugLimit}&offset=${offset}${methodParam}`,
				);
				if (!res.ok) {
					throw new Error(
						`Backend debug fetch failed for ${backend} (${res.status})`,
					);
				}
				const data = (await res.json()) as TrafficPage & { backend: string };
				setBackendEntries((current) => ({
					...current,
					[backend]: {
						...(current[backend] ?? {
							name: backend,
							page,
							methodFilter: method ?? '',
						}),
						page,
						data,
					},
				}));
			} catch (err) {
				setDebugError((err as Error).message);
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
		<div className="container mx-auto max-w-6xl p-6 space-y-6">
			<header className="space-y-2">
				<div className="flex items-center justify-between gap-3">
					<div>
						<h1 className="text-3xl font-bold">{t('debug.title')}</h1>
						<p className="text-muted-foreground">
							{t('debug.client.subtitle')}
						</p>
					</div>
					<Button
						type="button"
						onClick={() => onNavigate('main')}
						className="text-sm"
					>
						{t('debug.back')}
					</Button>
				</div>
			</header>

			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={() => void loadDebugSummary()}
					className="inline-flex items-center rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted transition"
				>
					{t('debug.refresh')}
				</button>
				{debugError ? (
					<span className="text-xs text-red-600">{debugError}</span>
				) : null}
			</div>

			<Card>
				<CardHeader>
					<CardTitle>{t('debug.client.title')}</CardTitle>
					<CardDescription>{t('debug.client.subtitle')}</CardDescription>
				</CardHeader>
				<CardContent className="space-y-3">
					<TrafficTable
						records={(debugClient?.records ?? []) as TrafficRecord[]}
					/>
					<PaginationControls
						page={clientPage}
						limit={debugLimit}
						total={debugClient?.total ?? 0}
						onPageChange={(page) => void loadClientPage(page)}
					/>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>{t('debug.backend.title')}</CardTitle>
					<CardDescription>{t('debug.client.subtitle')}</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					{backendList.map((entry) => (
						<Card key={entry.name}>
							<CardHeader className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
								<div className="min-w-0">
									<CardTitle className="text-base truncate">
										{entry.name}
									</CardTitle>
									<CardDescription>
										{t('debug.gatewayPrefix')} {entry.name}
									</CardDescription>
								</div>
								<div className="flex items-center gap-2">
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
										className="w-44 rounded border px-2 py-1 text-xs"
									/>
									<button
										type="button"
										onClick={() =>
											void loadBackendPage(entry.name, 0, entry.methodFilter)
										}
										className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted transition"
									>
										{t('backends.refresh')}
									</button>
								</div>
							</CardHeader>
							<CardContent className="space-y-3">
								<TrafficTable
									records={(entry.data?.records ?? []) as TrafficRecord[]}
								/>
								<PaginationControls
									page={entry.page}
									limit={debugLimit}
									total={entry.data?.total ?? 0}
									onPageChange={(next) =>
										void loadBackendPage(entry.name, next, entry.methodFilter)
									}
								/>
							</CardContent>
						</Card>
					))}
				</CardContent>
			</Card>
		</div>
	);
};

export { DebugPage };
