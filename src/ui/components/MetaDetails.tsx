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
		<div className="space-y-1 text-xs text-muted-foreground">
			{nextCursor ? (
				<div className="font-mono">nextCursor: {nextCursor}</div>
			) : null}
			{meta ? (
				<div>
					<div className="font-semibold text-foreground">_meta</div>
					<JsonPreview data={meta} />
				</div>
			) : null}
		</div>
	);
};

export { MetaDetails };
