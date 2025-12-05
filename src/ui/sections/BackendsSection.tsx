import { t } from '@/i18n';
import type { BackendStatus } from '@/types/overview';
import { JsonPreview } from '@/ui/components/JsonPreview';
import { MetaDetails } from '@/ui/components/MetaDetails';
import { PromptList } from '@/ui/components/PromptList';
import { ResourceList } from '@/ui/components/ResourceList';
import { StatusBadge } from '@/ui/components/StatusBadge';
import { ToolList } from '@/ui/components/ToolList';
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@/ui/shadcn/card';

type Props = {
	backends: BackendStatus[];
	onRefresh: () => void;
};

const BackendsSection = ({ backends, onRefresh }: Props) => (
	<section className="space-y-4">
		<h2 className="text-2xl font-semibold">{t('backends.sectionTitle')}</h2>
		{backends.map((backend) => (
			<Card key={backend.serverName}>
				<CardHeader className="gap-1">
					<div className="flex items-center justify-between gap-3">
						<div className="min-w-0">
							<CardTitle className="text-lg truncate">
								{backend.serverName}
							</CardTitle>
							<CardDescription className="break-all">
								{backend.url}
							</CardDescription>
						</div>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={onRefresh}
								className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted transition"
							>
								{t('backends.refresh')}
							</button>
							<StatusBadge
								ok={backend.connected}
								labelConnected={t('status.connected')}
								labelUnavailable={t('status.unavailable')}
							/>
						</div>
					</div>
					{backend.error ? (
						<p className="text-sm text-red-600">{backend.error}</p>
					) : null}
				</CardHeader>
				<CardContent className="space-y-6">
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="space-y-1">
							<h3 className="text-base font-semibold">
								{t('implementation.title')}
							</h3>
							{backend.implementation ? (
								<div className="text-sm space-y-1">
									<div className="font-semibold">
										{backend.implementation.name} v
										{backend.implementation.version}
									</div>
									{backend.implementation.title ? (
										<div className="text-muted-foreground">
											{backend.implementation.title}
										</div>
									) : null}
									{backend.implementation.description ? (
										<div className="text-muted-foreground">
											{backend.implementation.description}
										</div>
									) : null}
									{backend.implementation.websiteUrl ? (
										<a
											href={backend.implementation.websiteUrl}
											target="_blank"
											rel="noreferrer"
											className="text-xs text-blue-600 hover:underline"
										>
											{backend.implementation.websiteUrl}
										</a>
									) : null}
								</div>
							) : (
								<p className="text-sm text-muted-foreground">
									{t('implementation.none')}
								</p>
							)}
						</div>
						<div className="space-y-1">
							<h3 className="text-base font-semibold">
								{t('capabilities.title')}
							</h3>
							{backend.capabilities ? (
								<JsonPreview data={backend.capabilities} />
							) : (
								<p className="text-sm text-muted-foreground">
									{t('capabilities.none')}
								</p>
							)}
						</div>
					</div>
					{backend.instructions ? (
						<div className="space-y-1">
							<h3 className="text-base font-semibold">
								{t('instructions.title')}
							</h3>
							<p className="text-sm text-muted-foreground whitespace-pre-wrap">
								{backend.instructions}
							</p>
						</div>
					) : null}

					<div className="space-y-2">
						<h3 className="text-base font-semibold">{t('tools.title')}</h3>
						<ToolList
							tools={backend.tools.tools}
							emptyLabel={t('list.empty.tools')}
						/>
						<MetaDetails
							nextCursor={backend.tools.nextCursor}
							meta={backend.tools._meta}
						/>
					</div>
					<div className="space-y-2">
						<h3 className="text-base font-semibold">{t('prompts.title')}</h3>
						<PromptList
							prompts={backend.prompts.prompts}
							emptyLabel={t('list.empty.prompts')}
						/>
						<MetaDetails
							nextCursor={backend.prompts.nextCursor}
							meta={backend.prompts._meta}
						/>
					</div>
					<div className="space-y-2">
						<h3 className="text-base font-semibold">{t('resources.title')}</h3>
						<ResourceList
							resources={backend.resources.resources}
							emptyLabel={t('list.empty.resources')}
						/>
						<MetaDetails
							nextCursor={backend.resources.nextCursor}
							meta={backend.resources._meta}
						/>
					</div>
				</CardContent>
			</Card>
		))}
	</section>
);

export { BackendsSection };
