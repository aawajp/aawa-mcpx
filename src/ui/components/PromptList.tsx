import type { Prompt } from '@modelcontextprotocol/sdk/types.js';

type Props = { prompts: Prompt[]; emptyLabel: string };

const PromptList = ({ prompts, emptyLabel }: Props) => {
	if (!prompts.length) {
		return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
	}
	return (
		<ul className="space-y-2">
			{prompts.map((prompt) => (
				<li key={prompt.name} className="rounded border border-muted p-3">
					<div className="font-semibold">{prompt.name}</div>
					{prompt.description ? (
						<p className="text-sm text-muted-foreground">
							{prompt.description}
						</p>
					) : null}
				</li>
			))}
		</ul>
	);
};

export { PromptList };
