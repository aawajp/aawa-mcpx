import { type ReactNode, useId } from 'react';

import { type AccessState, REALMS, USER_TYPES } from '@/shared/ui_api';
import { CHECKBOX_CLASS } from '@/ui/base_components/classes';
import { type Column, useSort } from '@/ui/components/sort';
import {
	Cell,
	SortHeads,
	Table,
	TableCard,
	TimeCell,
} from '@/ui/components/table';
import { t } from '@/ui/i18n';
import {
	NEW_ROW_KEY,
	type Realm,
	type User,
	useRowDrafts,
} from '@/ui/sections/auth/common';
import { NewKeyButton } from '@/ui/sections/auth/keys';
import { RowActions, SaveControl, TextCell } from '@/ui/sections/auth/rows';

type UserType = User['type'];
// Empty names of OIDC users stay empty until the user's tokens fill them.
type UserDraft = Pick<User, 'id' | 'realm' | 'type' | 'enabled'> & {
	name: string;
	username: string;
};

const NEW_USER: Omit<UserDraft, 'realm' | 'type'> = {
	id: '',
	name: '',
	username: '',
	enabled: true,
};

const USER_COLUMNS: Column<User>[] = [
	{
		label: 'auth.name',
		width: 'w-32',
		value: (user) => user.name ?? '',
	},
	{
		label: 'auth.username',
		width: 'w-32',
		value: (user) => user.username ?? '',
	},
	{
		label: 'auth.userId',
		width: 'w-40',
		value: (user) => user.id,
	},
	{
		label: 'auth.realm',
		width: 'w-20',
		value: (user) => user.realm,
	},
	{
		label: 'auth.type',
		width: 'w-28',
		value: (user) => user.type,
	},
	{
		label: 'auth.enabled',
		width: 'w-24',
		value: (user) => Number(user.enabled),
	},
	{
		label: 'auth.lastSeen',
		width: 'w-40',
		value: (user) => user.lastSeenAt ?? 0,
	},
];

// The user types a new user of the realm can have, the default first. Local
// users other than the superadmin are machines.
const typesOf = (realm: Realm): readonly [UserType, ...UserType[]] =>
	realm === 'local' ? ['machine'] : USER_TYPES;

const savedOf = (user: User): UserDraft => ({
	id: user.id,
	realm: user.realm,
	type: user.type,
	name: user.name ?? '',
	username: user.username ?? '',
	enabled: user.enabled,
});

// A saved user, or the empty last row that adds one, with its unsaved edits.
const UserRow = ({
	user,
	draft,
	formId,
	pending,
	onEdit: edit,
	onDelete,
	children,
}: {
	user?: User;
	draft: UserDraft;
	formId: string;
	pending: boolean;
	onEdit: (edit: Partial<UserDraft>) => void;
	onDelete?: () => void;
	// More buttons, after Delete.
	children?: ReactNode;
}) => {
	const isLocal = draft.realm === 'local';
	return (
		<tr>
			{/* SUPERADMIN_USERNAME names the superadmin. */}
			<TextCell
				formId={formId}
				value={draft.name}
				label={t('auth.name')}
				disabled={user?.superadmin}
				onChange={(name) =>
					edit({
						name,
					})
				}
			/>
			<TextCell
				formId={formId}
				value={draft.username}
				label={t('auth.username')}
				disabled={user?.superadmin}
				onChange={(username) =>
					edit({
						username,
					})
				}
			/>
			{/* Everything links to the user ID, so only a new OIDC user sets it;
			    a Local user's ID is generated. */}
			{user ? (
				<Cell>{user.id}</Cell>
			) : (
				<TextCell
					formId={formId}
					value={isLocal ? '' : draft.id}
					label={t('auth.userId')}
					placeholder={isLocal ? t('auth.generatedId') : t('auth.userId')}
					disabled={isLocal}
					onChange={(id) =>
						edit({
							id,
						})
					}
				/>
			)}
			{/* The realm is chosen once, when the user is added. */}
			<Cell>
				{user ? (
					t(`auth.realm.${user.realm}`)
				) : (
					<select
						form={formId}
						aria-label={t('auth.realm')}
						value={draft.realm}
						onChange={(event) => {
							const realm =
								REALMS.find((realm) => realm === event.target.value) ??
								draft.realm;
							edit({
								realm,
								type: typesOf(realm).includes(draft.type)
									? draft.type
									: typesOf(realm)[0],
							});
						}}
						className="w-full bg-transparent outline-none"
					>
						{REALMS.map((realm) => (
							<option key={realm} value={realm}>
								{t(`auth.realm.${realm}`)}
							</option>
						))}
					</select>
				)}
			</Cell>
			{/* So is the type; a new Local user is a machine. */}
			<Cell>
				{user ? (
					t(`auth.type.${user.type}`)
				) : (
					<select
						form={formId}
						aria-label={t('auth.type')}
						value={draft.type}
						disabled={typesOf(draft.realm).length === 1}
						onChange={(event) =>
							edit({
								type:
									USER_TYPES.find((type) => type === event.target.value) ??
									draft.type,
							})
						}
						className="w-full bg-transparent outline-none"
					>
						{typesOf(draft.realm).map((type) => (
							<option key={type} value={type}>
								{t(`auth.type.${type}`)}
							</option>
						))}
					</select>
				)}
			</Cell>
			<Cell className="text-center">
				{/* The superadmin stays enabled. */}
				<input
					type="checkbox"
					aria-label={t('auth.enabled')}
					checked={draft.enabled}
					disabled={user?.superadmin}
					onChange={(event) =>
						edit({
							enabled: event.target.checked,
						})
					}
					className={CHECKBOX_CLASS}
				/>
			</Cell>
			<TimeCell time={user?.lastSeenAt} />
			<RowActions pending={pending} onDelete={onDelete}>
				{children}
			</RowActions>
		</tr>
	);
};

const UsersCard = ({
	state,
	newRealm,
	pending,
	onSave,
	onDelete,
	onState,
}: {
	state: AccessState;
	newRealm: Realm;
	pending: boolean;
	// `create` for the empty last row.
	onSave: (draft: UserDraft, create: boolean) => Promise<boolean>;
	onDelete: (user: User) => void;
	onState: (state: AccessState) => void;
}) => {
	const formId = useId();
	const sorting = useSort(USER_COLUMNS);
	const { draftOf, edit, changesOf, saveAll } = useRowDrafts<UserDraft>();
	// A new user is in `newRealm` unless another realm is picked.
	const newUser: UserDraft = {
		...NEW_USER,
		realm: newRealm,
		type: typesOf(newRealm)[0],
	};
	const changes = changesOf([
		...state.users.map((user) => ({
			key: user.id,
			saved: savedOf(user),
		})),
		{
			key: NEW_ROW_KEY,
			saved: newUser,
		},
	]);
	return (
		<TableCard
			title={t('auth.users')}
			controls={
				<SaveControl
					formId={formId}
					changed={changes.length > 0}
					pending={pending}
					onSave={() =>
						void saveAll(changes, (key, draft) =>
							onSave(draft, key === NEW_ROW_KEY),
						)
					}
				/>
			}
		>
			<Table>
				<thead>
					<tr>
						<SortHeads sorting={sorting} />
						{/* Delete and New API key. */}
						<th />
					</tr>
				</thead>
				<tbody>
					{sorting.sorted(state.users).map((user) => (
						<UserRow
							key={user.id}
							user={user}
							draft={draftOf(user.id, savedOf(user))}
							formId={formId}
							pending={pending}
							onEdit={(next) => edit(user.id, next)}
							// The superadmin stays.
							onDelete={user.superadmin ? undefined : () => onDelete(user)}
						>
							{user.type === 'machine' ? (
								<NewKeyButton user={user} onState={onState} />
							) : null}
						</UserRow>
					))}
					<UserRow
						draft={draftOf(NEW_ROW_KEY, newUser)}
						formId={formId}
						pending={pending}
						onEdit={(next) => edit(NEW_ROW_KEY, next)}
					/>
				</tbody>
			</Table>
		</TableCard>
	);
};

export { UsersCard };
