import { t } from '@/ui/i18n';
import type { OverviewResponse } from '@/shared/ui_api';
import { StatusBadge } from '@/ui/components/StatusBadge';
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@/ui/base_components/card';

type Props = {
	overview: OverviewResponse | null;
	onRefresh: () => void;
	onToggleBackend: (params: { serverName: string; enabled: boolean }) => void;
	isBackendPending: (serverName: string) => boolean;
	status: 'idle' | 'loading' | 'error' | 'ready';
	error?: string | null;
};

const SummarySection = ({
	overview,
	onRefresh,
	onToggleBackend,
	isBackendPending,
	status,
	error,
}: Props) => {
	const sortedBackends = overview?.backends
		? [...overview.backends].sort((a, b) =>
				a.serverName.localeCompare(b.serverName, undefined, {
					sensitivity: 'base',
				}),
			)
		: [];
	const connectedCount =
		overview?.backends.filter((b) => b.connected).length ?? 0;
	const totalBackends = sortedBackends.length;

	return (
		<div className="grid gap-4 sm:grid-cols-2">
			<Card className="w-full">
				<CardHeader className="pb-2">
					<CardTitle>{t('backends.title')}</CardTitle>
					<CardDescription>{t('backends.subtitle')}</CardDescription>
				</CardHeader>
				<CardContent className="space-y-3 w-full">
					<div className="flex items-center justify-between gap-3">
						<div className="flex items-baseline gap-2">
							<span className="text-3xl font-semibold">{connectedCount}</span>
							<span className="text-muted-foreground">
								/ {totalBackends} {t('backends.onlineSuffix')}
							</span>
						</div>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={onRefresh}
								className="inline-flex items-center rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted transition"
							>
								{t('backends.refresh')}
							</button>
							{status === 'loading' ? (
								<span className="text-xs text-muted-foreground">
									{t('backends.loading')}
								</span>
							) : null}
							{status === 'error' && error ? (
								<span className="text-xs text-rose-300">{error}</span>
							) : null}
						</div>
					</div>
					<div className="space-y-2 w-full">
						{sortedBackends.length ? (
							<ul className="space-y-2">
								{sortedBackends.map((backend) => (
									<li
										key={backend.serverName}
										className="flex items-start justify-between gap-2 rounded border border-muted px-3 py-2 w-full"
									>
								<div className="min-w-0">
									<div className="backend-name text-base leading-tight truncate">
										{backend.serverName}
									</div>
									{!backend.enabled && backend.enabledTools.length > 0 ? (
										<div className="mt-1 text-xs text-amber-200">
											{t('backends.inactiveTools')}: {backend.enabledTools.length}
										</div>
									) : null}
								</div>
									<div className="flex shrink-0 items-center gap-2">
										<StatusBadge
											ok={backend.connected}
											labelConnected={t('status.connected')}
											labelUnavailable={
												backend.enabled
													? t('status.unavailable')
													: t('status.disabled')
											}
										/>
										<button
											type="button"
											disabled={isBackendPending(backend.serverName)}
											onClick={() =>
												onToggleBackend({
													serverName: backend.serverName,
													enabled: !backend.enabled,
												})
											}
											aria-pressed={backend.enabled}
											className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium transition hover:bg-muted disabled:cursor-wait disabled:opacity-50"
										>
											{isBackendPending(backend.serverName)
												? t('backends.updating')
												: backend.enabled
													? t('backends.disable')
													: t('backends.enable')}
										</button>
									</div>
								</li>
								))}
							</ul>
						) : (
							<p className="text-sm text-muted-foreground">
								{t('backends.none')}
							</p>
						)}
					</div>
				</CardContent>
			</Card>
			<Card>
				<CardHeader className="pb-2">
					<CardTitle>{t('protocol.title')}</CardTitle>
					<CardDescription>{t('protocol.subtitle')}</CardDescription>
				</CardHeader>
				<CardContent className="space-y-2 w-full">
					<div className="text-2xl font-semibold">
						{overview?.protocolVersion ?? '—'}
					</div>
					<div className="space-y-1 text-sm">
						<div className="font-semibold">{t('protocol.apisTitle')}</div>
						<ul className="list-disc space-y-1 pl-5 text-sm">
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
