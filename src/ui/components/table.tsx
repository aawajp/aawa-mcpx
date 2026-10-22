import type { ReactNode } from 'react';

import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from '@/ui/base_components/card';
import type { Sorting } from '@/ui/components/sort';
import { t } from '@/ui/i18n';

// A plain table with bordered cells; each column keeps its header's width.
const Table = ({ children }: { children: ReactNode }) => (
	<table className="w-max min-w-full border-collapse">{children}</table>
);

// The headers of the sortable columns; a click sorts by that column.
const SortHeads = <T,>({ sorting }: { sorting: Sorting<T> }) =>
	sorting.columns.map((column) => {
		const active = sorting.sort?.column === column;
		const descending = active && sorting.sort?.descending;
		return (
			<th
				key={column.label}
				aria-sort={active ? (descending ? 'descending' : 'ascending') : 'none'}
				className={`border px-2 py-1 text-center font-semibold ${column.width ?? ''}`}
			>
				<button
					type="button"
					onClick={() => sorting.sortBy(column)}
					className="inline-flex items-center gap-1"
				>
					{t(column.label)}
					<span className="inline-block w-3">
						{active ? (descending ? '▼' : '▲') : '↕'}
					</span>
				</button>
			</th>
		);
	});

// Keeps the width its column header sets; wider content scrolls sideways in
// the box inside it, since browsers differ on scrolling a cell itself.
const Cell = ({
	className = '',
	children,
}: {
	className?: string;
	children: ReactNode;
}) => (
	<td className={`max-w-0 border p-0 ${className}`}>
		<div className="overflow-x-auto whitespace-nowrap px-2 py-1">
			{children}
		</div>
	</td>
);

const TimeCell = ({ time }: { time?: number }) => (
	<Cell>{time ? new Date(time).toLocaleString() : '—'}</Cell>
);

// A card that widens with its table instead of cutting it, with any controls
// on its title line. Its after element reaches past it by the page's margin,
// which a page scrolled sideways keeps.
const TableCard = ({
	title,
	controls,
	children,
}: {
	title: string;
	controls?: ReactNode;
	children?: ReactNode;
}) => (
	<Card className="relative w-max min-w-full after:absolute after:top-0 after:-right-4 after:h-px after:w-4 after:content-['']">
		<CardHeader className="flex flex-wrap items-center gap-3">
			<CardTitle>{title}</CardTitle>
			{controls}
		</CardHeader>
		{children ? <CardContent>{children}</CardContent> : null}
	</Card>
);

export { Cell, SortHeads, Table, TableCard, TimeCell };
