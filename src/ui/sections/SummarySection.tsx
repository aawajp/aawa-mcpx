import { t } from '@/i18n';
import type { OverviewResponse } from '@/types/overview';
import { StatusBadge } from '@/ui/components/StatusBadge';
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@/ui/shadcn/card';

type Props = {
	overview: OverviewResponse | null;
	onRefresh: () => void;
	status: 'idle' | 'loading' | 'error' | 'ready';
	error?: string | null;
};

const SummarySection = ({ overview, onRefresh, status, error }: Props) => {
	const connectedCount =
		overview?.backends.filter((b) => b.connected).length ?? 0;
	const totalBackends = overview?.backends.length ?? 0;

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
								<span className="text-xs text-red-600">{error}</span>
							) : null}
						</div>
					</div>
					<div className="space-y-2 w-full">
						{overview?.backends?.length ? (
							<ul className="space-y-2">
								{overview.backends.map((backend) => (
									<li
										key={backend.serverName}
										className="flex items-start justify-between gap-2 rounded border border-muted px-3 py-2 w-full"
									>
										<div className="font-semibold leading-tight truncate">
											{backend.serverName}
										</div>
										<StatusBadge
											ok={backend.connected}
											labelConnected={t('status.connected')}
											labelUnavailable={t('status.unavailable')}
										/>
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
								<a className="text-blue-600 hover:underline" href="/mcp">
									/mcp
								</a>{' '}
								<span className="text-muted-foreground">
									{t('protocol.api.mcp')}
								</span>
							</li>
							<li>
								<a
									className="text-blue-600 hover:underline"
									href="/ui/overview"
								>
									/ui/overview
								</a>{' '}
								<span className="text-muted-foreground">
									{t('protocol.api.overview')}
								</span>
							</li>
							<li>
								<a className="text-blue-600 hover:underline" href="/ui/events">
									/ui/events
								</a>{' '}
								<span className="text-muted-foreground">
									{t('protocol.api.events')}
								</span>
							</li>
							<li>
								<a className="text-blue-600 hover:underline" href="/health">
									/health
								</a>{' '}
								<span className="text-muted-foreground">
									{t('protocol.api.health')}
								</span>
							</li>
							<li>
								<a className="text-blue-600 hover:underline" href="/debug">
									/debug
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
