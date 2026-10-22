import type { ClientActivity } from '@/shared/ui_api';
import { type Column, useSort } from '@/ui/components/sort';
import {
	Cell,
	SortHeads,
	Table,
	TableCard,
	TimeCell,
} from '@/ui/components/table';
import { t } from '@/ui/i18n';

const clientLabel = (entry: ClientActivity): string =>
	`${entry.client.name} · ${entry.client.version}`;

const LAST_SEEN: Column<ClientActivity> = {
	label: 'clients.lastSeen',
	width: 'w-56',
	value: (entry) => entry.lastSeen,
};
const COLUMNS: Column<ClientActivity>[] = [
	{
		label: 'clients.client',
		width: 'w-72',
		value: clientLabel,
	},
	{
		label: 'clients.user',
		width: 'w-40',
		value: (entry) => entry.user ?? '',
	},
	{
		label: 'clients.protocol',
		width: 'w-36',
		value: (entry) => entry.protocolVersion,
	},
	{
		label: 'clients.firstSeen',
		width: 'w-56',
		value: (entry) => entry.firstSeen,
	},
	LAST_SEEN,
];

const ClientsSection = ({ clients }: { clients: ClientActivity[] }) => {
	const sorting = useSort(COLUMNS, {
		column: LAST_SEEN,
		descending: true,
	});
	return (
		<TableCard title={t('clients.title')}>
			{clients.length === 0 ? (
				<p className="text-muted-foreground">{t('clients.none')}</p>
			) : (
				<Table>
					<thead>
						<tr>
							<SortHeads sorting={sorting} />
						</tr>
					</thead>
					<tbody>
						{sorting.sorted(clients).map((entry) => (
							<tr
								key={JSON.stringify([
									entry.client.name,
									entry.client.version,
									entry.userId,
									entry.protocolVersion,
								])}
							>
								<Cell>
									{clientLabel(entry)}
									{entry.client.title ? (
										<span className="text-muted-foreground">
											{' '}
											({entry.client.title})
										</span>
									) : null}
								</Cell>
								<Cell>{entry.user ?? '—'}</Cell>
								<Cell>{entry.protocolVersion}</Cell>
								<TimeCell time={entry.firstSeen} />
								<TimeCell time={entry.lastSeen} />
							</tr>
						))}
					</tbody>
				</Table>
			)}
		</TableCard>
	);
};

export { ClientsSection };
