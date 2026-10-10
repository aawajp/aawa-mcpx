import { t } from '@/ui/i18n';

type Props = {
	connected: boolean;
	enabled: boolean;
};

const StatusBadge = ({ connected, enabled }: Props) => {
	const label = connected
		? t('status.connected')
		: enabled
			? t('status.unavailable')
			: t('status.disabled');
	return (
		<span
			className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-semibold ${
				connected
					? 'border border-emerald-400/35 bg-emerald-500/15 text-emerald-200'
					: 'border border-rose-400/35 bg-rose-500/15 text-rose-200'
			}`}
		>
			{label}
		</span>
	);
};

export { StatusBadge };
