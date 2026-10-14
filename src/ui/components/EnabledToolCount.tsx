import type { McpUpstreamStatus } from '@/shared/ui_api';
import { t } from '@/ui/i18n';

type Props = {
	backend: McpUpstreamStatus;
	withLabel?: boolean;
};

const EnabledToolCount = ({ backend, withLabel = false }: Props) => {
	const enabled = backend.enabledTools.filter((name) =>
		backend.availableTools.includes(name),
	).length;
	return (
		<span className="whitespace-nowrap text-muted-foreground">
			{enabled}/{backend.availableTools.length}
			{withLabel ? ` ${t('backends.enabledToolsSuffix')}` : null}
		</span>
	);
};

export { EnabledToolCount };
