import { JsonPreview } from '@/ui/components/JsonPreview';

type Props = {
	nextCursor?: string;
	meta?: Record<string, unknown>;
};

const MetaDetails = ({ nextCursor, meta }: Props) => {
	if (!nextCursor && !meta) {
		return null;
	}

	return (
		<div className="space-y-1 text-muted-foreground">
			{nextCursor ? (
				<div className="font-mono">nextCursor: {nextCursor}</div>
			) : null}
			{meta ? (
				<details className="rounded border border-muted px-2 py-1 text-foreground">
					<summary className="cursor-pointer font-medium">_meta</summary>
					<div className="mt-1">
						<JsonPreview data={meta} />
					</div>
				</details>
			) : null}
		</div>
	);
};

export { MetaDetails };
