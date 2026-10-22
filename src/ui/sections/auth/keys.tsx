import { useId, useRef, useState } from 'react';

import {
	ACCESS_PATHS,
	type AccessState,
	accessStateType,
	createdKeyResponseType,
	KEY_HINT_LENGTH,
	OIDC_KEY_PREFIX,
	userLabel,
} from '@/shared/ui_api';
import { postJson, useRequest } from '@/ui/api/client';
import { Button } from '@/ui/base_components/button';
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
	ACTION_CELL_CLASS,
	INPUT_CLASS,
	type User,
	WIDE_CELL_CLASS,
} from '@/ui/sections/auth/common';

type ApiKey = AccessState['apiKeys'][number];
type KeyEntry = ApiKey & {
	userName: string;
};

// How long a Copy button says Copied.
const COPIED_MS = 1500;

const KEY_COLUMNS: Column<KeyEntry>[] = [
	{
		label: 'auth.user',
		width: 'w-36',
		value: (key) => key.userName,
	},
	{
		label: 'auth.keyId',
		width: 'w-56',
		value: (key) => key.id,
	},
	{
		label: 'auth.label',
		width: 'w-36',
		value: (key) => key.label,
	},
	{
		label: 'auth.key',
		width: 'w-24',
		value: (key) => key.hint,
	},
	{
		label: 'auth.created',
		width: 'w-48',
		value: (key) => key.createdAt,
	},
	{
		label: 'auth.lastUsed',
		width: 'w-48',
		value: (key) => key.lastUsedAt ?? 0,
	},
];

// An OIDC service account's API key, base64url-encoded like the gateway
// expects; built here so the secret never passes the dashboard API.
const oidcKeyOf = (clientId: string, secret: string) =>
	OIDC_KEY_PREFIX +
	btoa(
		String.fromCharCode(...new TextEncoder().encode(`${clientId}:${secret}`)),
	)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');

// The SHA-256 of a key in hex, as the gateway stores it.
const keyHash = async (key: string) =>
	Array.from(
		new Uint8Array(
			await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)),
		),
		(byte) => byte.toString(16).padStart(2, '0'),
	).join('');

const CopyRow = ({ label, value }: { label: string; value: string }) => {
	const [copied, setCopied] = useState(false);
	return (
		<tr>
			<td className={`${WIDE_CELL_CLASS} font-semibold`}>{label}</td>
			<td className={WIDE_CELL_CLASS}>
				<input
					readOnly
					value={value}
					aria-label={label}
					onFocus={(event) => event.target.select()}
					className={INPUT_CLASS}
				/>
			</td>
			<td className={ACTION_CELL_CLASS}>
				<Button
					type="button"
					onClick={() =>
						void navigator.clipboard.writeText(value).then(
							() => {
								setCopied(true);
								setTimeout(() => setCopied(false), COPIED_MS);
							},
							// Without clipboard access, the field can still be selected.
							() => undefined,
						)
					}
				>
					{copied ? t('auth.copied') : t('auth.copy')}
				</Button>
			</td>
		</tr>
	);
};

const InputRow = ({
	label,
	value,
	type = 'text',
	onChange,
}: {
	label: string;
	value: string;
	type?: 'text' | 'password';
	onChange: (value: string) => void;
}) => (
	<tr>
		<td className={`${WIDE_CELL_CLASS} font-semibold`}>{label}</td>
		<td className={WIDE_CELL_CLASS}>
			<input
				type={type}
				value={value}
				aria-label={label}
				autoComplete="off"
				onChange={(event) => onChange(event.target.value)}
				className={INPUT_CLASS}
			/>
		</td>
		<td className={ACTION_CELL_CLASS} />
	</tr>
);

// "New API key" and its popover. A Local user's key is made by the gateway;
// an OIDC service account's key is built here from its client ID (by default
// its Username, which may be the IdP's client ID) and a client secret from the
// IdP, and only its hash is sent. Either key is shown once.
const NewKeyButton = ({
	user,
	onState,
}: {
	user: User;
	onState: (state: AccessState) => void;
}) => {
	const popoverId = useId();
	const titleId = `${popoverId}-title`;
	const [label, setLabel] = useState('');
	const [clientId, setClientId] = useState('');
	const [secret, setSecret] = useState('');
	const [key, setKey] = useState('');
	// Counts openings and closings. A key is shown only in the opening that
	// asked for it; one made after it closed is listed and can be revoked.
	const toggles = useRef<number>(0);
	const { pending, error, setError, run } = useRequest();
	const isLocal = user.realm === 'local';
	const create = () =>
		run(async () => {
			const asked = toggles.current;
			const show = (made: string) => {
				if (toggles.current === asked) setKey(made);
			};
			if (isLocal) {
				const { key: created, ...state } = createdKeyResponseType.assert(
					await postJson(ACCESS_PATHS.createKey, {
						userId: user.id,
						label,
					}),
				);
				onState(state);
				show(created);
			} else {
				const built = oidcKeyOf(clientId.trim(), secret.trim());
				onState(
					accessStateType.assert(
						await postJson(ACCESS_PATHS.registerKey, {
							userId: user.id,
							label,
							hash: await keyHash(built),
							hint: built.slice(-KEY_HINT_LENGTH),
						}),
					),
				);
				show(built);
			}
		});
	return (
		<>
			<Button type="button" popoverTarget={popoverId}>
				{t('auth.newApiKey')}
			</Button>
			<div
				id={popoverId}
				popover="auto"
				role="dialog"
				aria-labelledby={titleId}
				// Opening takes the current Username; closing forgets the key and
				// the secret.
				onToggle={(event) => {
					toggles.current += 1;
					if (event.newState === 'open') setClientId(user.username ?? '');
					else {
						setLabel('');
						setSecret('');
						setKey('');
						setError(null);
					}
				}}
				className="m-auto w-full max-w-3xl space-y-2 rounded-xl border bg-background p-4 text-foreground shadow-sm backdrop:bg-black/50"
			>
				<div className="flex items-center justify-between gap-3">
					<h3 id={titleId} className="font-semibold">
						{t('auth.newApiKey')}: {userLabel(user)}
					</h3>
					<Button
						type="button"
						popoverTarget={popoverId}
						popoverTargetAction="hide"
					>
						{t('auth.close')}
					</Button>
				</div>
				<p className="text-muted-foreground">
					{key
						? t('auth.keyOnce')
						: isLocal
							? t('auth.createHint')
							: t('auth.registerHint')}
				</p>
				{error ? <p className="text-rose-300">{error}</p> : null}
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void create();
					}}
				>
					<Table>
						<tbody>
							{key ? (
								<>
									<CopyRow label={t('auth.apiKey')} value={key} />
									<CopyRow
										label={t('auth.header')}
										value={`Authorization: Bearer ${key}`}
									/>
								</>
							) : (
								<>
									<InputRow
										label={t('auth.label')}
										value={label}
										onChange={setLabel}
									/>
									{isLocal ? null : (
										<>
											<InputRow
												label={t('auth.clientId')}
												value={clientId}
												onChange={setClientId}
											/>
											<InputRow
												label={t('auth.clientSecret')}
												value={secret}
												type="password"
												onChange={setSecret}
											/>
										</>
									)}
								</>
							)}
						</tbody>
					</Table>
					{key ? null : (
						<Button
							type="submit"
							disabled={
								pending || (!isLocal && !(clientId.trim() && secret.trim()))
							}
							className="mt-2"
						>
							{isLocal ? t('auth.create') : t('auth.register')}
						</Button>
					)}
				</form>
			</div>
		</>
	);
};

// Every user's API keys: never the key itself, only its last characters.
const ApiKeysCard = ({
	state,
	pending,
	onRevoke,
}: {
	state: AccessState;
	pending: boolean;
	onRevoke: (key: ApiKey) => void;
}) => {
	const sorting = useSort(KEY_COLUMNS);
	const users = new Map(state.users.map((user) => [user.id, user]));
	const keys = state.apiKeys.map((key) => {
		const user = users.get(key.userId);
		return {
			...key,
			userName: user ? userLabel(user) : key.userId,
		};
	});
	return (
		<TableCard title={t('auth.apiKeys')}>
			{keys.length === 0 ? (
				<p className="text-muted-foreground">{t('auth.noKeys')}</p>
			) : (
				<Table>
					<thead>
						<tr>
							<SortHeads sorting={sorting} />
							<th />
						</tr>
					</thead>
					<tbody>
						{sorting.sorted(keys).map((key) => (
							<tr key={key.id}>
								<Cell>{key.userName}</Cell>
								<Cell className="font-mono">{key.id}</Cell>
								<Cell>{key.label}</Cell>
								<Cell className="font-mono">…{key.hint}</Cell>
								<TimeCell time={key.createdAt} />
								<TimeCell time={key.lastUsedAt} />
								<td className={ACTION_CELL_CLASS}>
									<Button
										type="button"
										disabled={pending}
										onClick={() => onRevoke(key)}
									>
										{t('auth.revoke')}
									</Button>
								</td>
							</tr>
						))}
					</tbody>
				</Table>
			)}
		</TableCard>
	);
};

export { ApiKeysCard, NewKeyButton };
