import type { ReactNode } from 'react';

type Item = {
	key: string;
	title: string;
	description?: string;
};

type Props = {
	items: Item[];
	emptyLabel: string;
	renderAction?: (key: string) => ReactNode;
};

const ItemList = ({ items, emptyLabel, renderAction }: Props) => {
	if (!items.length) {
		return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
	}
	return (
		<ul className="space-y-2">
			{items.map((item) => (
				<li key={item.key} className="rounded border border-muted p-3">
					<div className="flex items-start justify-between gap-2">
						<div className="font-semibold break-all">{item.title}</div>
						{renderAction ? renderAction(item.key) : null}
					</div>
					{item.description ? (
						<p className="text-sm text-muted-foreground">{item.description}</p>
					) : null}
				</li>
			))}
		</ul>
	);
};

export { ItemList };
