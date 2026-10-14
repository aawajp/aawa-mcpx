import { flushSync } from 'react-dom';

import type { OverviewResponse } from '@/shared/ui_api';
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@/ui/base_components/card';
import { BackendRefreshButton } from '@/ui/components/BackendRefreshButton';
import { BackendToggleButton } from '@/ui/components/BackendToggleButton';
import { EnabledToolCount } from '@/ui/components/EnabledToolCount';
import { StatusBadge } from '@/ui/components/StatusBadge';
import { t } from '@/ui/i18n';

const CELL = 'border-y border-muted px-1 py-1';

const SUMMARY_COLUMNS = [
	{
		label: 'backends.column.name',
		className: 'text-left',
	},
	{
		label: 'backends.column.enabledTools',
		className: 'text-right',
	},
	{
		label: 'backends.column.status',
		className: 'text-center',
	},
	{
		label: 'backends.column.toggle',
		className: 'text-center',
	},
] as const;

type Props = {
	overview: OverviewResponse | null;
	onRefresh: (serverName?: string) => void;
	onShowBackends: () => void;
	onToggleBackend: (params: { serverName: string; enabled: boolean }) => void;
	isBackendPending: (serverName: string) => boolean;
	isRefreshing: boolean;
	error?: string | null;
};

const SummarySection = ({
	overview,
	onRefresh,
	onShowBackends,
	onToggleBackend,
	isBackendPending,
	isRefreshing,
	error,
}: Props) => {
	const backends = overview?.backends ?? [];
	const connectedCount = backends.filter((b) => b.connected).length;

	return (
		<div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
			<Card className="w-full gap-2 py-3">
				<CardContent className="space-y-2 w-full px-4">
					<div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
						<div className="flex items-baseline gap-3">
							<CardTitle>{t('backends.title')}</CardTitle>
							<div className="flex items-baseline gap-1">
								<span className="font-semibold">{connectedCount}</span>
								<span className="text-muted-foreground">
									/ {backends.length} {t('backends.onlineSuffix')}
								</span>
							</div>
						</div>
						<div className="flex items-center gap-2 text-sm">
							<button
								type="button"
								onClick={() => onRefresh()}
								disabled={isRefreshing}
								className="inline-flex items-center rounded-md border px-2.5 py-0.5 leading-tight font-medium hover:bg-muted transition"
							>
								{t('backends.refreshAll')}
							</button>
							{isRefreshing ? (
								<span className="text-xs text-muted-foreground">
									{t('backends.loading')}
								</span>
							) : null}
							{error ? (
								<span className="text-xs text-rose-300">{error}</span>
							) : null}
						</div>
					</div>
					<div className="space-y-2 w-full">
						{backends.length ? (
							<table className="w-full border-separate border-spacing-y-1 text-sm">
								<thead className="text-muted-foreground">
									<tr>
										{SUMMARY_COLUMNS.map((column) => (
											<th
												key={column.label}
												className={`whitespace-nowrap px-1 font-normal first:pl-3 last:pr-3 ${column.className}`}
											>
												{t(column.label)}
											</th>
										))}
										<th />
									</tr>
								</thead>
								<tbody>
									{backends.map((backend) => (
										<tr key={backend.serverName}>
											<td
												className={`${CELL} w-full max-w-0 rounded-l border-l pl-3`}
											>
												<a
													href={`#${encodeURIComponent(backend.serverName)}`}
													onClick={() => flushSync(onShowBackends)}
													className="backend-name block truncate text-base leading-tight"
												>
													{backend.serverName}
												</a>
											</td>
											<td className={`${CELL} text-right`}>
												<EnabledToolCount backend={backend} />
											</td>
											<td className={`${CELL} text-center`}>
												<StatusBadge
													connected={backend.connected}
													error={backend.error}
													enabled={backend.enabled}
												/>
											</td>
											<td className={`${CELL} text-center`}>
												<BackendToggleButton
													backend={backend}
													isPending={isBackendPending(backend.serverName)}
													onToggle={onToggleBackend}
												/>
											</td>
											<td
												className={`${CELL} rounded-r border-r pr-3 text-center`}
											>
												<BackendRefreshButton
													backend={backend}
													isRefreshing={isRefreshing}
													onRefresh={onRefresh}
												/>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						) : (
							<p className="text-sm text-muted-foreground">
								{t('backends.none')}
							</p>
						)}
					</div>
				</CardContent>
			</Card>
			<Card className="gap-2 py-3">
				<CardHeader className="gap-0.5 px-4">
					<CardTitle>{t('protocol.title')}</CardTitle>
					<CardDescription>{t('protocol.subtitle')}</CardDescription>
				</CardHeader>
				<CardContent className="space-y-2 w-full px-4">
					<div className="font-semibold">
						{overview?.supportedProtocolVersions?.map((version) => (
							<div key={version}>{version}</div>
						)) ?? '—'}
					</div>
					<div className="space-y-1 text-sm">
						<div className="font-semibold">{t('protocol.apisTitle')}</div>
						<ul className="list-disc space-y-1 pl-5">
							<li>
								<a
									className="text-sky-300 hover:text-cyan-200 hover:underline"
									href="/mcp"
								>
									/mcp
								</a>{' '}
								<span className="text-muted-foreground">
									{t('protocol.api.mcp')}
								</span>
							</li>
							<li>
								<a
									className="text-sky-300 hover:text-cyan-200 hover:underline"
									href="/api/overview"
								>
									/api/overview
								</a>{' '}
								<span className="text-muted-foreground">
									{t('protocol.api.overview')}
								</span>
							</li>
							<li>
								<a
									className="text-sky-300 hover:text-cyan-200 hover:underline"
									href="/api/events"
								>
									/api/events
								</a>{' '}
								<span className="text-muted-foreground">
									{t('protocol.api.events')}
								</span>
							</li>
							<li>
								<a
									className="text-sky-300 hover:text-cyan-200 hover:underline"
									href="/api/health"
								>
									/api/health
								</a>{' '}
								<span className="text-muted-foreground">
									{t('protocol.api.health')}
								</span>
							</li>
							<li>
								<a
									className="text-sky-300 hover:text-cyan-200 hover:underline"
									href="/api/debug"
								>
									/api/debug
								</a>{' '}
								<span className="text-muted-foreground">
									{t('protocol.api.debug')}
								</span>
							</li>
						</ul>
					</div>
				</CardContent>
			</Card>
		</div>
	);
};

export { SummarySection };
