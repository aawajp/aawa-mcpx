import type { ClientActivity } from '@/shared/ui_api';
import { t } from '@/ui/i18n';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/ui/base_components/card';

const ClientsSection = ({ clients }: { clients: ClientActivity[] }) => (
	<section className="space-y-4">
		<h2 className="text-2xl font-semibold">{t('clients.title')}</h2>
		{clients.length === 0 ? <p className="text-sm text-muted-foreground">{t('clients.none')}</p> :
			<div className="grid gap-3">
				{[...clients].sort((a, b) => b.lastSeen - a.lastSeen).map((entry) => (
					<Card key={JSON.stringify([entry.client.name, entry.client.version])}>
						<CardHeader className="gap-1 pb-3">
							<CardTitle className="truncate text-xl">
								{entry.client.name} · {entry.client.version}
							</CardTitle>
							{entry.client.title ? <CardDescription>{entry.client.title}</CardDescription> : null}
						</CardHeader>
						<CardContent className="grid gap-3 pt-0 text-sm sm:grid-cols-3">
							<div><div className="text-xs text-muted-foreground">{t('clients.protocol')}</div>{entry.protocolVersion}</div>
							<div><div className="text-xs text-muted-foreground">{t('clients.firstSeen')}</div>{new Date(entry.firstSeen).toLocaleString()}</div>
							<div><div className="text-xs text-muted-foreground">{t('clients.lastSeen')}</div>{new Date(entry.lastSeen).toLocaleString()}</div>
						</CardContent>
					</Card>
				))}
			</div>}
	</section>
);

export { ClientsSection };
