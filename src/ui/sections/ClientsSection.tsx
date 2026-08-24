import { t } from '@/ui/i18n';
import type { ClientSession } from '@/shared/ui_api';
import { StatusBadge } from '@/ui/components/StatusBadge';
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@/ui/base_components/card';

type Props = {
	clients: ClientSession[];
};

const formatClientName = (client: ClientSession['client']): string => {
	const name = client.name ?? t('clients.unknown');
	return client.version ? `${name}-${client.version}` : name;
};

const formatTime = (value: number | undefined): string => {
	if (!value) return '—';
	return new Date(value).toLocaleString();
};

const statusLabel = (client: ClientSession): string => {
	if (client.status === 'connected') return t('clients.status.connected');
	return t('clients.status.disconnected');
};

const ClientsSection = ({ clients }: Props) => {
	const sorted = [...clients].sort((a, b) => b.lastSeen - a.lastSeen);

	return (
		<section className="space-y-4">
			<h2 className="text-2xl font-semibold">{t('clients.title')}</h2>
			{sorted.length === 0 ? (
				<p className="text-sm text-muted-foreground">{t('clients.none')}</p>
			) : (
				<div className="grid gap-3">
					{sorted.map((client) => (
						<Card key={client.sessionId}>
							<CardHeader className="gap-1 pb-3">
								<div className="flex items-center justify-between gap-3">
									<div className="min-w-0">
										<CardTitle className="truncate text-xl">
											{formatClientName(client.client)}
										</CardTitle>
										<CardDescription className="truncate">
											{client.client.title ?? t('clients.noTitle')}
										</CardDescription>
									</div>
									<StatusBadge
										ok={client.status === 'connected'}
										labelConnected={statusLabel(client)}
										labelUnavailable={statusLabel(client)}
									/>
								</div>
							</CardHeader>
							<CardContent className="grid gap-3 pt-0 text-sm sm:grid-cols-2 lg:grid-cols-4">
								<div>
									<div className="text-xs text-muted-foreground">
										{t('clients.session')}
									</div>
									<div className="truncate font-mono text-xs">
										{client.sessionId}
									</div>
								</div>
								<div>
									<div className="text-xs text-muted-foreground">
										{t('clients.protocol')}
									</div>
									<div>{client.protocolVersion ?? '—'}</div>
								</div>
								<div>
									<div className="text-xs text-muted-foreground">
										{t('clients.created')}
									</div>
									<div>{formatTime(client.createdAt)}</div>
								</div>
								<div>
									<div className="text-xs text-muted-foreground">
										{t('clients.lastSeen')}
									</div>
									<div>{formatTime(client.lastSeen)}</div>
								</div>
								{client.disconnectedAt ? (
									<div>
										<div className="text-xs text-muted-foreground">
											{t('clients.disconnected')}
										</div>
										<div>{formatTime(client.disconnectedAt)}</div>
									</div>
								) : null}
								{client.lastStatus ? (
									<div className="sm:col-span-2 lg:col-span-3">
										<div className="text-xs text-muted-foreground">
											{t('clients.lastStatus')}
										</div>
										<div>{client.lastStatus}</div>
									</div>
								) : null}
							</CardContent>
						</Card>
					))}
				</div>
			)}
		</section>
	);
};

export { ClientsSection };
