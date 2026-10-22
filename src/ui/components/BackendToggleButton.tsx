import type { McpUpstreamStatus } from '@/shared/ui_api';
import { Button } from '@/ui/base_components/button';
import { t } from '@/ui/i18n';

type Props = {
	backend: McpUpstreamStatus;
	isPending: boolean;
	onToggle: (params: { serverName: string; enabled: boolean }) => void;
};

const BackendToggleButton = ({ backend, isPending, onToggle }: Props) => (
	<Button
		type="button"
		disabled={isPending}
		onClick={() =>
			onToggle({
				serverName: backend.serverName,
				enabled: !backend.enabled,
			})
		}
		aria-pressed={backend.enabled}
		className="w-20 px-1 disabled:cursor-wait"
	>
		{isPending
			? t('backends.updating')
			: backend.enabled
				? t('backends.disable')
				: t('backends.enable')}
	</Button>
);

export { BackendToggleButton };
