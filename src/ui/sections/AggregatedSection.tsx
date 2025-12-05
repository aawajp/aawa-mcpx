import { t } from '@/i18n';
import type { OverviewResponse } from '@/types/overview';
import { PromptList } from '@/ui/components/PromptList';
import { ResourceList } from '@/ui/components/ResourceList';
import { ToolList } from '@/ui/components/ToolList';
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@/ui/shadcn/card';

type Props = { overview: OverviewResponse | null };

const AggregatedSection = ({ overview }: Props) => (
	<div className="space-y-4">
		<Card>
			<CardHeader>
				<CardTitle>{t('aggregated.tools.title')}</CardTitle>
				<CardDescription>{t('aggregated.tools.subtitle')}</CardDescription>
			</CardHeader>
			<CardContent>
				<ToolList
					tools={overview?.aggregated.tools ?? []}
					emptyLabel={t('list.empty.tools')}
				/>
			</CardContent>
		</Card>

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
