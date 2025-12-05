type Props = { ok: boolean; labelConnected: string; labelUnavailable: string };

const StatusBadge = ({ ok, labelConnected, labelUnavailable }: Props) => (
	<span
		className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-semibold ${
			ok ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
		}`}
	>
		{ok ? labelConnected : labelUnavailable}
	</span>
);

export { StatusBadge };
