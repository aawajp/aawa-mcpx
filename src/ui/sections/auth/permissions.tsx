import {
	type ChangeEvent,
	type ReactNode,
	useLayoutEffect,
	useRef,
	useState,
} from 'react';

import {
	type AccessState,
	type BackendOverview,
	userLabel,
} from '@/shared/ui_api';
import { Button } from '@/ui/base_components/button';
import { CHECKBOX_CLASS } from '@/ui/base_components/classes';
import { type Column, type Sorting, useSort } from '@/ui/components/sort';
import { Cell, SortHeads, Table, TableCard } from '@/ui/components/table';
import { t } from '@/ui/i18n';
import { type Save, useDraft } from '@/ui/sections/auth/common';

type Permission = AccessState['permissions'][number];
type HolderType = Permission['holderType'];
type Holder = {
	type: HolderType;
	id: string;
};
// A backend's row in Permissions, with the holder's saved grants on it.
type BackendEntry = {
	name: string;
	enabled: boolean;
	removed: boolean;
	tools: string[];
	permitted: boolean;
	toolGrants: number;
};

const BADGE_CLASS =
	'rounded border border-sky-400/35 bg-sky-500/15 px-1.5 py-0.5 leading-tight text-sky-100';
// The backend permission: prompts, resources and resource templates.
const BACKEND_TOOL = '';

const PERMISSION_COLUMNS: Column<BackendEntry>[] = [
	{
		label: 'auth.permitted',
		width: 'w-28',
		value: (backend) => Number(backend.permitted),
	},
	{
		label: 'auth.backend',
		width: 'w-1/5',
		value: (backend) => backend.name,
	},
	{
		label: 'auth.tools',
		value: (backend) => backend.toolGrants,
	},
];

// Columns as wide as the widest entry, measured after each render, so no
// name wraps. They fill the width; the order runs top-down, then left-right.
const ToolColumns = ({ children }: { children: ReactNode }) => {
	const ref = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const entries = [...(ref.current?.children ?? [])];
		setWidth(
			Math.ceil(
				Math.max(
					0,
					...entries.map((entry) => entry.getBoundingClientRect().width),
				),
			),
		);
	});
	return (
		<div
			ref={ref}
			className="gap-x-4"
			style={{
				columnWidth: width ? `${width}px` : undefined,
			}}
		>
			{children}
		</div>
	);
};

const permissionKey = (backend: string, tool: string) =>
	JSON.stringify([backend, tool]);

// The grants of one holder.
const GrantsCard = ({
	state,
	backends,
	holder,
	holderSelect,
	sorting,
	pending,
	onSave,
}: {
	state: AccessState;
	backends: BackendOverview[];
	holder: Holder;
	holderSelect: ReactNode;
	sorting: Sorting<BackendEntry>;
	pending: boolean;
	onSave: Save<Pick<Permission, 'backend' | 'tool'>[]>;
}) => {
	const user =
		holder.type === 'user'
			? state.users.find((entry) => entry.id === holder.id)
			: undefined;
	const grants = (holderType: HolderType, holderIds: string[]) =>
		state.permissions.filter(
			(permission) =>
				permission.holderType === holderType &&
				holderIds.includes(permission.holderId),
		);
	const ownGrants = grants(holder.type, [holder.id]);
	// For a user, the grants that come from their roles.
	const roleGrants = user ? grants('role', user.roleIds) : [];
	const savedKeys = ownGrants
		.map((permission) => permissionKey(permission.backend, permission.tool))
		.sort();
	const { draft, changed, edit, reset } = useDraft(
		{
			keys: savedKeys,
		},
		JSON.stringify([holder.type, holder.id]),
	);
	const roleName = (id: string) =>
		state.roles.find((role) => role.id === id)?.name ?? id;
	const viaBadges = (backend: string, tool: string) =>
		roleGrants
			.filter(
				(permission) =>
					permission.backend === backend && permission.tool === tool,
			)
			.map((permission) => (
				<span key={permission.holderId} className={BADGE_CLASS}>
					{t('auth.via')} {roleName(permission.holderId)}
				</span>
			));
	const permissionCheckbox = (backend: string, tool: string) => {
		const key = permissionKey(backend, tool);
		return {
			type: 'checkbox',
			checked: draft.keys.includes(key),
			onChange: (event: ChangeEvent<HTMLInputElement>) =>
				edit({
					keys: event.target.checked
						? [...draft.keys, key].sort()
						: draft.keys.filter((entry) => entry !== key),
				}),
			className: CHECKBOX_CLASS,
		};
	};
	const configured = new Map(
		backends.map((backend) => [backend.serverName, backend]),
	);
	// Backends removed from the config keep their grants visible, so they can
	// be revoked.
	const names = new Set([
		...configured.keys(),
		...[...ownGrants, ...roleGrants].map((permission) => permission.backend),
	]);
	const rows = [...names].map((name) => {
		const backend = configured.get(name);
		const own = ownGrants.filter((permission) => permission.backend === name);
		return {
			name,
			enabled: backend?.enabled ?? false,
			removed: !backend,
			// Tools no longer reported keep their permissions visible.
			tools: [
				...new Set([
					...(backend?.availableTools ?? []),
					...[...own, ...roleGrants]
						.filter(
							(permission) =>
								permission.backend === name && permission.tool !== BACKEND_TOOL,
						)
						.map((permission) => permission.tool),
				]),
			].sort((a, b) => a.localeCompare(b)),
			permitted: own.some((permission) => permission.tool === BACKEND_TOOL),
			toolGrants: own.filter((permission) => permission.tool !== BACKEND_TOOL)
				.length,
		};
	});
	// Sets or clears every tool permission of these backends in the draft;
	// backend permissions stay. Tools of removed backends are only cleared.
	const setAllTools = (permit: boolean, names: string[]) =>
		edit({
			keys: permit
				? [
						...new Set([
							...draft.keys,
							...rows
								.filter(
									(backend) => names.includes(backend.name) && !backend.removed,
								)
								.flatMap((backend) =>
									backend.tools.map((tool) =>
										permissionKey(backend.name, tool),
									),
								),
						]),
					].sort()
				: draft.keys.filter((key) => {
						const [backend, tool] = JSON.parse(key) as [string, string];
						return !names.includes(backend) || tool === BACKEND_TOOL;
					}),
		});
	const allNames = rows.map((backend) => backend.name);

	return (
		<TableCard
			title={t('auth.permissions')}
			controls={
				<>
					{holderSelect}
					<Button
						type="button"
						disabled={pending}
						onClick={() => setAllTools(true, allNames)}
					>
						{t('auth.permitAllTools')}
					</Button>
					<Button
						type="button"
						disabled={pending}
						onClick={() => setAllTools(false, allNames)}
					>
						{t('auth.revokeAllTools')}
					</Button>
					{changed ? (
						<Button
							type="button"
							disabled={pending}
							onClick={() =>
								void onSave(
									draft.keys.map((key) => {
										const [backend, tool] = JSON.parse(key) as [string, string];
										return {
											backend,
											tool,
										};
									}),
								).then((saved) => {
									if (saved) reset();
								})
							}
						>
							{t('auth.save')}
						</Button>
					) : null}
				</>
			}
		>
			<Table>
				<thead>
					<tr>
						<SortHeads sorting={sorting} />
					</tr>
				</thead>
				<tbody>
					{sorting.sorted(rows).map((backend) => (
						<tr key={backend.name}>
							<Cell className="text-center">
								<input
									aria-label={backend.name}
									{...permissionCheckbox(backend.name, BACKEND_TOOL)}
								/>
							</Cell>
							<Cell className="font-medium">
								<div className="flex flex-wrap items-center gap-2">
									{backend.name}
									{backend.enabled ? null : (
										<span className="font-normal text-muted-foreground">
											({t(backend.removed ? 'list.removed' : 'list.disabled')})
										</span>
									)}
									{viaBadges(backend.name, BACKEND_TOOL)}
								</div>
							</Cell>
							<Cell>
								{backend.tools.length > 0 ? (
									<div className="mb-1 flex gap-2">
										{backend.removed ? null : (
											<Button
												type="button"
												disabled={pending}
												onClick={() => setAllTools(true, [backend.name])}
											>
												{t('auth.permitAll')}
											</Button>
										)}
										<Button
											type="button"
											disabled={pending}
											onClick={() => setAllTools(false, [backend.name])}
										>
											{t('auth.revokeAll')}
										</Button>
									</div>
								) : null}
								<ToolColumns>
									{backend.tools.map((tool) => (
										<label
											key={tool}
											className="flex w-max items-center gap-2 whitespace-nowrap break-inside-avoid"
										>
											<input {...permissionCheckbox(backend.name, tool)} />
											{tool}
											{viaBadges(backend.name, tool)}
										</label>
									))}
								</ToolColumns>
							</Cell>
						</tr>
					))}
				</tbody>
			</Table>
		</TableCard>
	);
};

// Permissions, for the holder picked in its controls.
const PermissionsCard = ({
	state,
	backends,
	pending,
	onSave,
}: {
	state: AccessState;
	backends: BackendOverview[];
	pending: boolean;
	onSave: (
		holder: Holder,
		grants: Pick<Permission, 'backend' | 'tool'>[],
	) => Promise<boolean>;
}) => {
	const [holder, setHolder] = useState<Holder | null>(null);
	const sorting = useSort(PERMISSION_COLUMNS);
	// The chosen holder, or the first one when none is chosen or it was deleted.
	const holders: Holder[] = [
		...state.users.map((user) => ({
			type: 'user' as const,
			id: user.id,
		})),
		...state.roles.map((role) => ({
			type: 'role' as const,
			id: role.id,
		})),
	];
	const selected =
		holders.find(
			(entry) => entry.type === holder?.type && entry.id === holder.id,
		) ?? holders.at(0);
	if (!selected)
		return (
			<TableCard
				title={t('auth.permissions')}
				controls={
					<span className="text-muted-foreground">{t('auth.noHolders')}</span>
				}
			/>
		);
	const holderSelect = (
		<select
			aria-label={t('auth.holder')}
			value={JSON.stringify([selected.type, selected.id])}
			onChange={(event) => {
				const [type, id] = JSON.parse(event.target.value) as [
					HolderType,
					string,
				];
				setHolder({
					type,
					id,
				});
			}}
			className="rounded-md border bg-transparent px-2 py-0.5"
		>
			<optgroup label={t('auth.users')}>
				{state.users.map((user) => (
					<option key={user.id} value={JSON.stringify(['user', user.id])}>
						{userLabel(user)}
					</option>
				))}
			</optgroup>
			<optgroup label={t('auth.roles')}>
				{state.roles.map((role) => (
					<option key={role.id} value={JSON.stringify(['role', role.id])}>
						{role.name}
					</option>
				))}
			</optgroup>
		</select>
	);
	return (
		<GrantsCard
			state={state}
			backends={backends}
			holder={selected}
			holderSelect={holderSelect}
			sorting={sorting}
			pending={pending}
			onSave={(grants) => onSave(selected, grants)}
		/>
	);
};

export { PermissionsCard };
