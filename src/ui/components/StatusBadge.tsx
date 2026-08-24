type Props = { ok: boolean; labelConnected: string; labelUnavailable: string };

const StatusBadge = ({ ok, labelConnected, labelUnavailable }: Props) => (
	<span
		className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-semibold ${
			ok
				? 'border border-emerald-400/35 bg-emerald-500/15 text-emerald-200'
				: 'border border-rose-400/35 bg-rose-500/15 text-rose-200'
		}`}
	>
		{ok ? labelConnected : labelUnavailable}
	</span>
);

export { StatusBadge };
