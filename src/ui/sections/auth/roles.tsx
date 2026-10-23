import { useId } from 'react';

import { type AccessState, userLabel } from '@/shared/ui_api';
import { CHECKBOX_CLASS } from '@/ui/base_components/classes';
import { type Column, useSort } from '@/ui/components/sort';
import { SortHeads, Table, TableCard } from '@/ui/components/table';
import { t } from '@/ui/i18n';
import {
	NEW_ROW_KEY,
	type User,
	useRowDrafts,
	WIDE_CELL_CLASS,
} from '@/ui/sections/auth/common';
import { RowActions, SaveControl, TextCell } from '@/ui/sections/auth/rows';

type Role = AccessState['roles'][number];
type RoleDraft = Pick<Role, 'name'> & {
	userIds: string[];
};
// A role with its saved members.
type RoleEntry = Role & Pick<RoleDraft, 'userIds'>;
// A choice in a membership cell; `detected` when the user's last token named
// the role.
type Member = {
	id: string;
	name: string;
	detected: boolean;
};

const NEW_ROLE: RoleDraft = {
	name: '',
	userIds: [],
};
const DETECTED_CLASS = 'text-emerald-400';

const ROLE_COLUMNS: Column<RoleEntry>[] = [
	{
		label: 'auth.name',
		width: 'w-1/5',
		value: (role) => role.name,
	},
	{
		label: 'auth.users',
		value: (role) => role.userIds.length,
	},
];

// Checkboxes for the users of a role; users whose last token named the role
// are green.
const MemberCell = ({
	members,
	selected,
	onChange,
}: {
	members: Member[];
	selected: string[];
	onChange: (selected: string[]) => void;
}) => (
	<td className={WIDE_CELL_CLASS}>
		<div className="flex gap-x-3">
			{members.map((member) => (
				<label
					key={member.id}
					className={`inline-flex items-center gap-1 ${member.detected ? DETECTED_CLASS : ''}`}
				>
					<input
						type="checkbox"
						checked={selected.includes(member.id)}
						onChange={(event) =>
							onChange(
								event.target.checked
									? [...selected, member.id].sort((a, b) => a.localeCompare(b))
									: selected.filter((id) => id !== member.id),
							)
						}
						className={CHECKBOX_CLASS}
					/>
					{member.name}
				</label>
			))}
		</div>
	</td>
);

// A saved role, or the empty last row that adds one, with its unsaved edits.
const RoleRow = ({
	role,
	draft,
	users,
	formId,
	pending,
	onEdit,
	onDelete,
}: {
	role?: RoleEntry;
	draft: RoleDraft;
	users: User[];
	formId: string;
	pending: boolean;
	onEdit: (edit: Partial<RoleDraft>) => void;
	onDelete?: () => void;
}) => (
	<tr>
		<TextCell
			formId={formId}
			value={draft.name}
			label={t('auth.name')}
			onChange={(name) =>
				onEdit({
					name,
				})
			}
		/>
		<MemberCell
			members={users.map((user) => ({
				id: user.id,
				name: userLabel(user),
				detected: role !== undefined && user.idpRoles.includes(role.name),
			}))}
			selected={draft.userIds}
			onChange={(userIds) =>
				onEdit({
					userIds,
				})
			}
		/>
		<RowActions pending={pending} onDelete={onDelete} />
	</tr>
);

const RolesCard = ({
	state,
	pending,
	onSave,
	onDelete,
}: {
	state: AccessState;
	pending: boolean;
	// No ID for the empty last row.
	onSave: (id: string | undefined, draft: RoleDraft) => Promise<boolean>;
	onDelete: (role: Role) => void;
}) => {
	const formId = useId();
	const sorting = useSort(ROLE_COLUMNS);
	const { draftOf, edit, changesOf, saveAll } = useRowDrafts<RoleDraft>();
	const roles = state.roles.map((role) => ({
		...role,
		userIds: state.users
			.filter((user) => user.roleIds.includes(role.id))
			.map((user) => user.id)
			.sort((a, b) => a.localeCompare(b)),
	}));
	const savedOf = (role: RoleEntry): RoleDraft => ({
		name: role.name,
		userIds: role.userIds,
	});
	const changes = changesOf([
		...roles.map((role) => ({
			key: role.id,
			saved: savedOf(role),
		})),
		{
			key: NEW_ROW_KEY,
			saved: NEW_ROLE,
		},
	]);
	return (
		<TableCard
			title={t('auth.roles')}
			controls={
				<SaveControl
					formId={formId}
					changed={changes.length > 0}
					pending={pending}
					onSave={() =>
						void saveAll(changes, (key, draft) =>
							onSave(key === NEW_ROW_KEY ? undefined : key, {
								...draft,
								// Users deleted since the edit drop out.
								userIds: draft.userIds.filter((id) =>
									state.users.some((user) => user.id === id),
								),
							}),
						)
					}
				/>
			}
		>
			<Table>
				<thead>
					<tr>
						<SortHeads sorting={sorting} />
						{/* Delete. */}
						<th />
					</tr>
				</thead>
				<tbody>
					{sorting.sorted(roles).map((role) => (
						<RoleRow
							key={role.id}
							role={role}
							draft={draftOf(role.id, savedOf(role))}
							users={state.users}
							formId={formId}
							pending={pending}
							onEdit={(next) => edit(role.id, next)}
							onDelete={() => onDelete(role)}
						/>
					))}
					<RoleRow
						draft={draftOf(NEW_ROW_KEY, NEW_ROLE)}
						users={state.users}
						formId={formId}
						pending={pending}
						onEdit={(next) => edit(NEW_ROW_KEY, next)}
					/>
				</tbody>
			</Table>
		</TableCard>
	);
};

export { RolesCard };
