import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { JsonPreview } from '@/ui/components/JsonPreview';
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@/ui/shadcn/card';

type Props = { tools: Tool[]; emptyLabel: string };

const ToolList = ({ tools, emptyLabel }: Props) => {
	if (!tools.length) {
		return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
	}

	return (
		<div className="grid gap-3">
			{tools.map((tool) => (
				<Card key={tool.name} className="border border-muted">
					<CardHeader className="pb-2">
						<div className="flex items-start justify-between gap-2">
							<CardTitle className="text-base font-semibold">
								{tool.name}
							</CardTitle>
							<span className="text-xs text-muted-foreground">inputSchema</span>
						</div>
						{tool.description ? (
							<CardDescription>{tool.description}</CardDescription>
						) : null}
					</CardHeader>
					<CardContent className="pt-0">
						<JsonPreview data={tool.inputSchema} />
					</CardContent>
				</Card>
			))}
		</div>
	);
};

export { ToolList };
