import { t } from '@/ui/i18n';
import type { McpUpstreamStatus } from '@/shared/ui_api';
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
} from '@/ui/base_components/card';

const backendLabel = (backend: McpUpstreamStatus): string => {
	switch (backend.type) {
		case 'http':
			return backend.url;
		case 'stdio':
			return backend.command;
	}
};

type Props = {
	backends: McpUpstreamStatus[];
	onRefresh: () => void;
	onToggleTool: (params: { name: string; enabled: boolean }) => void;
	isToolEnabled: (name: string) => boolean;
	isToolPending: (name: string) => boolean;
};

const BackendsSection = ({
	backends,
	onRefresh,
	onToggleTool,
	isToolEnabled,
	isToolPending,
}: Props) => {
	const sortedBackends = [...backends].sort((a, b) =>
		a.serverName.localeCompare(b.serverName, undefined, {
			sensitivity: 'base',
		}),
	);

	return (
		<section className="space-y-4">
			<h2 className="text-2xl font-semibold">{t('backends.sectionTitle')}</h2>
			{sortedBackends.map((backend) => (
				<Card key={backend.serverName}>
					<CardHeader className="gap-1 pb-3">
						<div className="flex items-center justify-between gap-3">
							<div className="min-w-0">
								<CardTitle className="backend-name backend-name-strong text-2xl truncate">
									{backend.serverName}
								</CardTitle>
								<CardDescription className="break-all">
									{backendLabel(backend)}
								</CardDescription>
							</div>
							<div className="flex items-center gap-2">
								<button
									type="button"
									onClick={onRefresh}
									className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium hover:bg-muted transition"
								>
									{t('backends.refresh')}
								</button>
								<StatusBadge
									ok={backend.connected}
									labelConnected={t('status.connected')}
									labelUnavailable={
										backend.enabled
											? t('status.unavailable')
											: t('status.disabled')
									}
								/>
								{backend.errorState === 'configuration' ? (
									<span className="rounded border border-rose-400/35 bg-rose-500/15 px-2 py-1 text-xs font-medium text-rose-200">
										{t('status.configurationError')}
									</span>
								) : null}
								{backend.errorState === 'protocol' ? (
									<span className="rounded border border-rose-400/35 bg-rose-500/15 px-2 py-1 text-xs font-medium text-rose-200">
										{t('status.protocolError')}
									</span>
								) : null}
							</div>
						</div>
						{backend.error ? (
							<p className="text-sm text-rose-300">{backend.error}</p>
						) : null}
						{backend.errorState === 'protocol' ? (
							<p className="text-sm text-amber-300">{t('status.protocolRetryStopped')}</p>
						) : null}
					{backend.actionRequired ? (
							<p className="text-xs font-semibold text-rose-200">
								{t('status.actionRequired')}
							</p>
					) : null}
					{!backend.enabled ? (
						<div className="rounded-md border border-amber-300/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
							<p>{t('backends.disabledNotice')}</p>
							{backend.enabledTools.length > 0 ? (
								<ul className="mt-2 flex flex-wrap gap-2">
									{backend.enabledTools.map((toolName) => (
										<li
											key={toolName}
											className="rounded border border-amber-300/30 px-2 py-1 font-mono text-xs"
										>
											{toolName}
										</li>
									))}
								</ul>
							) : null}
						</div>
					) : null}
				</CardHeader>
					<CardContent className="space-y-4 pt-0">
						<div className="grid gap-2 sm:grid-cols-2">
							<div className="space-y-1">
								<h3 className="text-base font-semibold">
									{t('implementation.title')}
								</h3>
								<p className="text-sm">{t('protocol.title')}: {backend.protocolVersion ?? '—'}</p>
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
												className="text-xs text-sky-300 hover:text-cyan-200 hover:underline"
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
									<details className="rounded border border-muted p-2">
										<summary className="cursor-pointer text-sm font-medium">
											{t('tool.fold.schema')}
										</summary>
										<div className="mt-2">
											<JsonPreview data={backend.capabilities} />
										</div>
									</details>
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
								renderAction={(tool) => {
									const namespacedToolName = `${backend.serverName}__${tool.name}`;
									const enabled = isToolEnabled(namespacedToolName);
									const pending = isToolPending(namespacedToolName);
									return (
										<label className="inline-flex items-center gap-2 text-xs font-medium text-slate-200">
											<input
												type="checkbox"
												checked={enabled}
												disabled={pending}
												onChange={(event) =>
													onToggleTool({
														name: namespacedToolName,
														enabled: event.target.checked,
													})
												}
												className="h-4 w-4 rounded border border-sky-400/50 bg-slate-950"
											/>
											{t('aggregated.tools.toggle')}
										</label>
									);
								}}
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
							<h3 className="text-base font-semibold">
								{t('resources.title')}
							</h3>
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
};

export { BackendsSection };
