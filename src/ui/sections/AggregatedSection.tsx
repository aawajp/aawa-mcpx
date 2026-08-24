import { t } from '@/ui/i18n';
import type { OverviewResponse } from '@/shared/ui_api';
import { PromptList } from '@/ui/components/PromptList';
import { ResourceList } from '@/ui/components/ResourceList';
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@/ui/base_components/card';

type Props = {
	overview: OverviewResponse | null;
};

const AggregatedSection = ({ overview }: Props) => (
	<div className="space-y-4">
		<Card>
			<CardHeader>
				<CardTitle>{t('aggregated.prompts.title')}</CardTitle>
				<CardDescription>{t('aggregated.prompts.subtitle')}</CardDescription>
			</CardHeader>
			<CardContent>
				<PromptList
					prompts={overview?.aggregated.prompts ?? []}
					emptyLabel={t('list.empty.prompts')}
				/>
			</CardContent>
		</Card>

		<Card>
			<CardHeader>
				<CardTitle>{t('aggregated.resources.title')}</CardTitle>
				<CardDescription>{t('aggregated.resources.subtitle')}</CardDescription>
			</CardHeader>
			<CardContent>
				<ResourceList
					resources={overview?.aggregated.resources ?? []}
					emptyLabel={t('list.empty.resources')}
				/>
			</CardContent>
		</Card>
	</div>
);

export { AggregatedSection };
