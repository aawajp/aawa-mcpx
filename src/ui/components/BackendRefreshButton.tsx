import type { McpUpstreamStatus } from '@/shared/ui_api';
import { Button } from '@/ui/base_components/button';
import { t } from '@/ui/i18n';

type Props = {
	backend: McpUpstreamStatus;
	isRefreshing: boolean;
	onRefresh: (serverName: string) => void;
};

const BackendRefreshButton = ({ backend, isRefreshing, onRefresh }: Props) => (
	<Button
		type="button"
		onClick={() => onRefresh(backend.serverName)}
		disabled={isRefreshing}
		className="px-2"
	>
		{t('backends.refresh')}
	</Button>
);

export { BackendRefreshButton };
