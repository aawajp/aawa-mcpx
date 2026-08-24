import type { ReactNode } from 'react';

import { t } from '@/ui/i18n';
import type { Tool } from '@/shared/ui_api';
import { JsonPreview } from '@/ui/components/JsonPreview';
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from '@/ui/base_components/card';

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
	const sortedTools = [...tools].sort((a, b) =>
		a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
	);

	if (!tools.length) {
		return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
	}

	return (
		<div className="grid gap-2">
			{sortedTools.map((tool) => (
				<Card
					key={tool.name}
					className="border border-sky-400/35 bg-slate-900/45 shadow-[0_6px_18px_rgba(2,6,23,0.35)]"
				>
					<CardHeader className="pb-1">
						<div className="flex items-start justify-between gap-2">
							<CardTitle className="text-base font-bold text-sky-100">
								{tool.name}
							</CardTitle>
							{renderAction ? (
								renderAction(tool)
							) : (
								<span className="text-xs text-muted-foreground">
									inputSchema
								</span>
							)}
						</div>
					</CardHeader>
					<CardContent className="pt-0 space-y-1.5">
						{tool.description ? (
							<details className="py-0.5">
								<summary className="cursor-pointer text-sm font-semibold text-slate-200">
									{t('tool.fold.description')}
								</summary>
								<p className="mt-2 text-sm text-muted-foreground whitespace-pre-wrap">
									{tool.description}
								</p>
							</details>
						) : null}
						<details className="py-0.5">
							<summary className="cursor-pointer text-sm font-semibold text-slate-200">
								{t('tool.fold.schema')}
							</summary>
							<div className="mt-2">
								<JsonPreview data={tool.inputSchema} />
							</div>
						</details>
					</CardContent>
				</Card>
			))}
		</div>
	);
};

export { ToolList };
