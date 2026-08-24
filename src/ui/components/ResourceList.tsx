import type { Resource } from '@/shared/ui_api';

type Props = { resources: Resource[]; emptyLabel: string };

const ResourceList = ({ resources, emptyLabel }: Props) => {
	if (!resources.length) {
		return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
	}
	return (
		<ul className="space-y-2">
			{resources.map((resource) => (
				<li key={resource.uri} className="rounded border border-muted p-3">
					<div className="font-semibold break-all">{resource.uri}</div>
					{resource.description ? (
						<p className="text-sm text-muted-foreground">
							{resource.description}
						</p>
					) : null}
				</li>
			))}
		</ul>
	);
};

export { ResourceList };
