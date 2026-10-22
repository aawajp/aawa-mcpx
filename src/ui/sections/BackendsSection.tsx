import type { ReactNode } from 'react';

import { addPrefix } from '@/shared/mcp_namespaces';
import type { BackendOverview, McpUpstreamStatus } from '@/shared/ui_api';
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from '@/ui/base_components/card';
import { CHECKBOX_CLASS } from '@/ui/base_components/classes';
import { BackendRefreshButton } from '@/ui/components/BackendRefreshButton';
import { BackendToggleButton } from '@/ui/components/BackendToggleButton';
import { EnabledToolCount } from '@/ui/components/EnabledToolCount';
import { ItemList } from '@/ui/components/ItemList';
import { JsonPreview } from '@/ui/components/JsonPreview';
import { MetaDetails } from '@/ui/components/MetaDetails';
import { StatusBadge } from '@/ui/components/StatusBadge';
import { ToolList } from '@/ui/components/ToolList';
import { t } from '@/ui/i18n';

const ERROR_STATE_LABELS = {
	configuration: 'status.configurationError',
	protocol: 'status.protocolError',
	authentication: 'status.authenticationError',
} as const;

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
	<span>
		<span className="text-muted-foreground">{label}:</span> {children}
	</span>
);

const backendEndpoint = (
	backend: McpUpstreamStatus,
): { key: string; value: string } => {
	switch (backend.type) {
		case 'http':
			return {
				key: 'url',
				value: backend.url,
			};
		case 'stdio':
			return {
				key: 'command',
				value: backend.command,
			};
	}
};

type Props = {
	backends: BackendOverview[];
	onRefresh: (serverName: string) => void;
	isRefreshing: boolean;
	onToggleBackend: (params: { serverName: string; enabled: boolean }) => void;
	isBackendPending: (serverName: string) => boolean;
	onToggleTool: (params: {
		serverName: string;
		toolName: string;
		enabled: boolean;
	}) => void;
	isToolPending: (serverName: string, toolName: string) => boolean;
};

const BackendsSection = ({
	backends,
	onRefresh,
	isRefreshing,
	onToggleBackend,
	isBackendPending,
	onToggleTool,
	isToolPending,
}: Props) => {
	const renderToolToggle = (backend: McpUpstreamStatus, toolName: string) => (
		<label className="inline-flex items-center gap-2 font-medium text-slate-200">
			<input
				type="checkbox"
				aria-label={`${t('tools.toggle')}: ${toolName}`}
				checked={backend.enabledTools.includes(toolName)}
				disabled={isToolPending(backend.serverName, toolName)}
				onChange={(event) =>
					onToggleTool({
						serverName: backend.serverName,
						toolName,
						enabled: event.target.checked,
					})
				}
				className={CHECKBOX_CLASS}
			/>
			{t('tools.toggle')}
		</label>
	);

	return (
		<section className="space-y-4">
			<h2 className="text-2xl font-semibold">{t('backends.title')}</h2>
			{backends.map((backend) => (
				<Card
					key={backend.serverName}
					id={backend.serverName}
					className="scroll-mt-4"
				>
					<CardHeader className="flex flex-col items-stretch gap-1">
						<div className="grid items-start gap-x-6 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto]">
							<div className="min-w-0">
								<CardTitle className="backend-name backend-name-strong text-2xl truncate">
									{backend.serverName}
								</CardTitle>
								<div className="flex flex-wrap gap-x-4 break-all">
									<Field label="type">{backend.type}</Field>
									<Field label={backendEndpoint(backend).key}>
										{backendEndpoint(backend).value}
									</Field>
									<Field label="protocol">
										{backend.protocolVersion ?? '—'}
									</Field>
								</div>
							</div>
							<div className="flex items-center gap-2">
								<EnabledToolCount backend={backend} withLabel />
								<StatusBadge
									connected={backend.connected}
									error={backend.error}
									enabled={backend.enabled}
								/>
								<BackendToggleButton
									backend={backend}
									isPending={isBackendPending(backend.serverName)}
									onToggle={onToggleBackend}
								/>
								<BackendRefreshButton
									backend={backend}
									isRefreshing={isRefreshing}
									onRefresh={onRefresh}
								/>
								{backend.errorState && backend.errorState !== 'runtime' ? (
									<span className="rounded border border-rose-400/35 bg-rose-500/15 px-2 py-0.5 leading-tight font-medium text-rose-200">
										{t(ERROR_STATE_LABELS[backend.errorState])}
									</span>
								) : null}
							</div>
						</div>
						{backend.error ? (
							<p className="text-rose-300">{backend.error}</p>
						) : null}
						{backend.errorState === 'protocol' ? (
							<p className="text-amber-300">
								{t('status.protocolRetryStopped')}
							</p>
						) : null}
						{backend.actionRequired ? (
							<p className="font-semibold text-rose-200">
								{t('status.actionRequired')}
							</p>
						) : null}
					</CardHeader>
					<CardContent className="space-y-4 pt-0">
						{backend.implementation ||
						backend.capabilities ||
						backend.instructions ? (
							<div className="grid items-start gap-2 sm:grid-cols-3">
								{backend.implementation ? (
									<details className="rounded border border-muted px-2 py-1">
										<summary className="cursor-pointer font-medium">
											{t('implementation.fold')}
										</summary>
										<div className="mt-1">
											<JsonPreview data={backend.implementation} />
										</div>
									</details>
								) : null}
								{backend.capabilities ? (
									<details className="rounded border border-muted px-2 py-1">
										<summary className="cursor-pointer font-medium">
											{t('capabilities.fold')}
										</summary>
										<div className="mt-1">
											<JsonPreview data={backend.capabilities} />
										</div>
									</details>
								) : null}
								{backend.instructions ? (
									<details className="rounded border border-muted px-2 py-1">
										<summary className="cursor-pointer font-medium">
											{t('instructions.title')}
										</summary>
										<p className="mt-1 text-muted-foreground whitespace-pre-wrap">
											{backend.instructions}
										</p>
									</details>
								) : null}
							</div>
						) : null}

						<div className="grid items-start gap-3 sm:grid-cols-2">
							<div className="space-y-2">
								<h3 className="text-base font-semibold">
									{t('prompts.title')}
								</h3>
								<MetaDetails
									nextCursor={backend.prompts.nextCursor}
									meta={backend.prompts._meta}
								/>
								<ItemList
									items={backend.prompts.prompts.map((prompt) => ({
										key: prompt.name,
										title: addPrefix({
											serverName: backend.serverName,
											name: prompt.name,
										}),
										description: prompt.description,
									}))}
									emptyLabel={t('list.empty.prompts')}
								/>
							</div>
							<div className="space-y-2">
								<h3 className="text-base font-semibold">
									{t('resources.title')}
								</h3>
								<MetaDetails
									nextCursor={backend.resources.nextCursor}
									meta={backend.resources._meta}
								/>
								<ItemList
									items={backend.resources.resources.map((resource) => ({
										key: resource.uri,
										title: resource.uri,
										description: resource.description,
									}))}
									emptyLabel={t('list.empty.resources')}
								/>
							</div>
						</div>
						<div className="space-y-2">
							<h3 className="text-base font-semibold">{t('tools.title')}</h3>
							<MetaDetails
								nextCursor={backend.tools.nextCursor}
								meta={backend.tools._meta}
							/>
							{backend.tools.tools.length ? (
								<ToolList
									serverName={backend.serverName}
									tools={backend.tools.tools}
									emptyLabel={t('list.empty.tools')}
									renderAction={(tool) => renderToolToggle(backend, tool.name)}
								/>
							) : (
								<ItemList
									items={backend.availableTools.map((name) => ({
										key: name,
										title: addPrefix({
											serverName: backend.serverName,
											name,
										}),
									}))}
									emptyLabel={t('list.empty.tools')}
									renderAction={(name) => renderToolToggle(backend, name)}
								/>
							)}
						</div>
					</CardContent>
				</Card>
			))}
		</section>
	);
};

export { BackendsSection };
