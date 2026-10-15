import type { McpUpstreamStatus } from '@/shared/ui_api';
import { t } from '@/ui/i18n';

type Props = {
	backend: McpUpstreamStatus;
	isRefreshing: boolean;
	onRefresh: (serverName: string) => void;
};

const BackendRefreshButton = ({ backend, isRefreshing, onRefresh }: Props) => (
	<button
		type="button"
		onClick={() => onRefresh(backend.serverName)}
		disabled={isRefreshing}
		className="inline-flex items-center rounded-md border px-2 py-0.5 leading-tight font-medium transition hover:bg-muted disabled:opacity-50"
	>
		{t('backends.refresh')}
	</button>
);

export { BackendRefreshButton };
