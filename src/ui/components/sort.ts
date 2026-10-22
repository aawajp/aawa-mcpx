import { useState } from 'react';

import type { StringKey } from '@/ui/i18n';

// A sortable column: its label, its header's width and the saved value it
// sorts by.
type Column<T> = {
	label: StringKey;
	width?: string;
	value: (row: T) => string | number;
};
type Sort<T> = {
	column: Column<T>;
	descending: boolean;
};

const compare = (a: string | number, b: string | number): number =>
	typeof a === 'number' && typeof b === 'number'
		? a - b
		: String(a).localeCompare(String(b), undefined, {
				sensitivity: 'base',
			});

// Rows in the order of the column last picked: a new column sorts ascending
// first, the same column flips direction. Rows keep their given order until
// then, unless `initial` sorts them.
const useSort = <T>(
	columns: readonly Column<T>[],
	initial: Sort<T> | null = null,
) => {
	const [sort, setSort] = useState(initial);
	return {
		columns,
		sort,
		sortBy: (column: Column<T>) =>
			setSort((current) => ({
				column,
				descending: current?.column === column && !current.descending,
			})),
		sorted: (rows: readonly T[]) =>
			sort
				? rows.toSorted(
						(a, b) =>
							compare(sort.column.value(a), sort.column.value(b)) *
							(sort.descending ? -1 : 1),
					)
				: rows,
	};
};

type Sorting<T> = ReturnType<typeof useSort<T>>;

export type { Column, Sorting };
export { useSort };
