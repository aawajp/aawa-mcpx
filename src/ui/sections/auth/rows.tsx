import type { ReactNode } from 'react';

import { Button } from '@/ui/base_components/button';
import { Cell } from '@/ui/components/table';
import { t } from '@/ui/i18n';
import { ACTION_CELL_CLASS, CELL_INPUT_CLASS } from '@/ui/sections/auth/common';

// Save on a card's title line, shown only with unsaved changes. The rows'
// fields join its form by its ID, so Enter saves too.
const SaveControl = ({
	formId,
	changed,
	pending,
	onSave,
}: {
	formId: string;
	changed: boolean;
	// While a request runs, so a double click does not send it twice.
	pending: boolean;
	onSave: () => void;
}) => (
	<form
		id={formId}
		onSubmit={(event) => {
			event.preventDefault();
			if (changed) onSave();
		}}
	>
		{changed ? (
			<Button type="submit" disabled={pending}>
				{t('auth.save')}
			</Button>
		) : null}
	</form>
);

// Delete and any more buttons in a row's last column.
const RowActions = ({
	pending,
	onDelete,
	children,
}: {
	pending: boolean;
	onDelete?: () => void;
	children?: ReactNode;
}) => (
	<td className={ACTION_CELL_CLASS}>
		<div className="flex gap-2">
			{onDelete ? (
				<Button type="button" disabled={pending} onClick={onDelete}>
					{t('auth.delete')}
				</Button>
			) : null}
			{children}
		</div>
	</td>
);

const TextCell = ({
	formId,
	value,
	label,
	placeholder = label,
	disabled,
	onChange,
}: {
	formId: string;
	value: string;
	label: string;
	placeholder?: string;
	disabled?: boolean;
	onChange: (value: string) => void;
}) => (
	<Cell>
		<input
			form={formId}
			value={value}
			placeholder={placeholder}
			aria-label={label}
			autoComplete="off"
			disabled={disabled}
			onChange={(event) => onChange(event.target.value)}
			className={CELL_INPUT_CLASS}
		/>
	</Cell>
);

export { RowActions, SaveControl, TextCell };
