import { type ReactNode, useState } from 'react';

import type { Tool } from '@/shared/ui_api';
import { Card, CardContent } from '@/ui/base_components/card';
import { JsonPreview } from '@/ui/components/JsonPreview';
import { t } from '@/ui/i18n';

type ToolCardProps<T extends Tool> = {
	tool: T;
	renderAction?: (tool: T) => ReactNode;
};

const ToolCard = <T extends Tool>({ tool, renderAction }: ToolCardProps<T>) => {
	const [open, setOpen] = useState(false);
	return (
		<Card className="gap-0 border border-sky-400/35 bg-slate-900/45 py-0 shadow-[0_6px_18px_rgba(2,6,23,0.35)]">
			<div className="flex items-center gap-2 pr-3">
				<button
					type="button"
					onClick={() => setOpen((current) => !current)}
					aria-expanded={open}
					className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-2 text-left text-sky-100 transition hover:text-cyan-200"
				>
					<span
						aria-hidden="true"
						className={`w-4 shrink-0 text-center leading-none transition-transform ${open ? 'rotate-90' : ''}`}
					>
						▸
					</span>
					<span className="truncate leading-tight">{tool.name}</span>
				</button>
				{renderAction ? renderAction(tool) : null}
			</div>
			{open ? (
				<CardContent className="space-y-2 px-3 pb-2">
					{tool.description ? (
						<p className="text-muted-foreground whitespace-pre-wrap">
							{tool.description}
						</p>
					) : null}
					<div className="space-y-1">
						<h4 className="font-semibold text-slate-200">
							{t('tool.inputSchema')}
						</h4>
						<JsonPreview data={tool.inputSchema} />
					</div>
					{tool.outputSchema !== undefined ? (
						<div className="space-y-1">
							<h4 className="font-semibold text-slate-200">
								{t('tool.outputSchema')}
							</h4>
							<JsonPreview data={tool.outputSchema} />
						</div>
					) : null}
				</CardContent>
			) : null}
		</Card>
	);
};

type Props<T extends Tool> = {
	tools: T[];
	emptyLabel: string;
	renderAction?: (tool: T) => ReactNode;
};

const ToolList = <T extends Tool>({
	tools,
	emptyLabel,
	renderAction,
}: Props<T>) => {
	if (!tools.length) {
		return <p className="text-muted-foreground">{emptyLabel}</p>;
	}

	return (
		<div className="grid gap-2">
			{tools.map((tool) => (
				<ToolCard key={tool.name} tool={tool} renderAction={renderAction} />
			))}
		</div>
	);
};

export { ToolList };
