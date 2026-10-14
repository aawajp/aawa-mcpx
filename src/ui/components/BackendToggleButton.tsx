import type { McpUpstreamStatus } from '@/shared/ui_api';
import { t } from '@/ui/i18n';

type Props = {
	backend: McpUpstreamStatus;
	isPending: boolean;
	onToggle: (params: { serverName: string; enabled: boolean }) => void;
};

const BackendToggleButton = ({ backend, isPending, onToggle }: Props) => (
	<button
		type="button"
		disabled={isPending}
		onClick={() =>
			onToggle({
				serverName: backend.serverName,
				enabled: !backend.enabled,
			})
		}
		aria-pressed={backend.enabled}
		className="inline-flex w-20 items-center justify-center rounded-md border px-1 py-0.5 leading-tight font-medium transition hover:bg-muted disabled:cursor-wait disabled:opacity-50"
	>
		{isPending
			? t('backends.updating')
			: backend.enabled
				? t('backends.disable')
				: t('backends.enable')}
	</button>
);

export { BackendToggleButton };
