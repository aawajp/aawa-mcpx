import { useState } from 'react';

import type { AccessState } from '@/shared/ui_api';

type User = AccessState['users'][number];
type Realm = User['realm'];
// Resolves to whether the change was saved.
type Save<T> = (draft: T) => Promise<boolean>;

// Text fields fill their cell.
const INPUT_LOOK_CLASS =
	'bg-transparent outline-none placeholder:text-muted-foreground focus:bg-muted/40';
const INPUT_CLASS = `w-full ${INPUT_LOOK_CLASS}`;
// A table cell's text field grows with its text, so the cell scrolls to all
// of it.
const CELL_INPUT_CLASS = `field-sizing-content min-w-full ${INPUT_LOOK_CLASS}`;
// Widens its column to show all of its content.
const WIDE_CELL_CLASS = 'whitespace-nowrap border px-2 py-1';
// The button column stays outside the grid.
const ACTION_CELL_CLASS = 'py-1 pl-2';

// Unsaved edits on top of the saved values. Edits belong to their scope, such
// as the holder being edited, and never pass to another one.
const useDraft = <T extends object>(saved: T, scope = '') => {
	const [edits, setEdits] = useState<{ scope: string; changes: Partial<T> }>({
		scope,
		changes: {},
	});
	const changes = edits.scope === scope ? edits.changes : {};
	const draft = {
		...saved,
		...changes,
	};
	return {
		draft,
		changed: JSON.stringify(draft) !== JSON.stringify(saved),
		edit: (next: Partial<T>) =>
			setEdits((current) => ({
				scope,
				changes: {
					...(current.scope === scope ? current.changes : {}),
					...next,
				},
			})),
		// Called once a save of this render's draft succeeds: edits made while
		// it ran stay.
		reset: () =>
			setEdits((current) =>
				current === edits
					? {
							scope,
							changes: {},
						}
					: current,
			),
	};
};

// The key of a card's empty last row; saved rows' IDs are never empty.
const NEW_ROW_KEY = '';

type Row<T> = {
	key: string;
	saved: T;
};

// Unsaved edits of a card's rows by key, on top of each row's saved values,
// for one Save on the card's title line.
const useRowDrafts = <T extends object>() => {
	const [edits, setEdits] = useState<Record<string, Partial<T>>>({});
	const draftOf = (key: string, saved: T): T => ({
		...saved,
		...edits[key],
	});
	return {
		draftOf,
		edit: (key: string, next: Partial<T>) =>
			setEdits((current) => ({
				...current,
				[key]: {
					...current[key],
					...next,
				},
			})),
		// The rows whose draft differs from their saved values; edits of rows
		// that are gone are left out.
		changesOf: (rows: Row<T>[]) =>
			rows.flatMap(({ key, saved }) => {
				const draft = draftOf(key, saved);
				return JSON.stringify(draft) === JSON.stringify(saved)
					? []
					: [
							{
								key,
								draft,
							},
						];
			}),
		// Saves the changes in turn and stops at the first refusal. A saved row
		// drops its edits, unless it was edited again meanwhile.
		saveAll: async (
			changes: {
				key: string;
				draft: T;
			}[],
			save: (key: string, draft: T) => Promise<boolean>,
		) => {
			for (const { key, draft } of changes) {
				const saving = edits[key];
				if (!(await save(key, draft))) return;
				setEdits((current) => {
					if (current[key] !== saving) return current;
					const { [key]: _, ...rest } = current;
					return rest;
				});
			}
		},
	};
};

export type { Realm, Row, Save, User };
export {
	ACTION_CELL_CLASS,
	CELL_INPUT_CLASS,
	INPUT_CLASS,
	NEW_ROW_KEY,
	useDraft,
	useRowDrafts,
	WIDE_CELL_CLASS,
};
