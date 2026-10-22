import { t } from '@/ui/i18n';

type Props = {
	connected: boolean;
	enabled: boolean;
	error?: string;
};

const StatusBadge = ({ connected, enabled, error }: Props) => {
	const label = connected
		? t('status.connected')
		: !enabled
			? t('status.disabled')
			: error
				? t('status.unavailable')
				: t('status.connecting');
	return (
		<span
			className={`inline-flex w-28 items-center justify-center rounded-full px-2 py-0.5 leading-tight font-semibold ${
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
