import { logFields, logger } from '@/server/logger';
import {
	type AccessState,
	KEY_HINT_LENGTH,
	LOCAL_KEY_PREFIX,
} from '@/shared/ui_api';

import type { Database } from 'bun:sqlite';

// Random bytes of a Local user's API key.
const LOCAL_KEY_BYTES = 32;

// MCP client users and roles live in the gateway. OIDC users map to the
// identity provider by `id` (the IdP's user ID, which never changes, so
// everything links to it); Local users get a generated `id`. A user's realm
// (OIDC users from the identity provider, Local users from the gateway
// itself) and type (humans sign in themselves, machines use API keys) never
// change. Roles map by name (a key of the token's roles claim). `name` and
// `username` are labels: tokens fill them while empty, but never overwrite
// them. A user has the roles assigned to it (`roleIds`): roles named in its
// tokens are assigned too, and unassigned once a later token drops them,
// even if also assigned in the dashboard; roles assigned only in the
// dashboard stay. `idpRoles` keeps the roles of
// the user's last token. One Local human is the superadmin, who can log in to
// the dashboard; other Local users are machines.
type AccessUser = AccessState['users'][number];
type Realm = AccessUser['realm'];
type UserType = AccessUser['type'];

// An API key of a machine user. Only a hash of the
// key is stored; `hint` is its last characters, to tell keys apart.
type ApiKey = AccessState['apiKeys'][number];

// An empty tool is the backend permission (prompts, resources and templates).
type Permission = AccessState['permissions'][number];
type HolderType = Permission['holderType'];

// What a user may use: their own permissions plus those of their roles.
type Access = {
	allowsBackend: (backend: string) => boolean;
	allowsTool: (backend: string, tool: string) => boolean;
};

// Why the store refuses a change: input it cannot use, an ID it does not
// know, or a rule or existing data the change conflicts with.
class InvalidInputError extends Error {}
class UnknownIdError extends Error {}
class ConflictError extends Error {}

type UserRow = {
	id: string;
	realm: Realm;
	type: UserType;
	superadmin: number;
	name: string | null;
	username: string | null;
	enabled: number;
	created_at: number;
	last_seen_at: number | null;
	idp_roles: string;
	role_ids: string | null;
};

type RoleRow = {
	id: string;
	name: string;
	created_at: number;
};

type PermissionRow = {
	holder_type: HolderType;
	holder_id: string;
	backend: string;
	tool: string;
};

type ApiKeyRow = {
	id: string;
	user_id: string;
	label: string;
	hash: string;
	hint: string;
	created_at: number;
	last_used_at: number | null;
};

const fromUserRow = (row: UserRow): AccessUser => ({
	id: row.id,
	realm: row.realm,
	type: row.type,
	superadmin: row.superadmin === 1,
	name: row.name ?? undefined,
	username: row.username ?? undefined,
	enabled: row.enabled === 1,
	roleIds: row.role_ids ? row.role_ids.split(',').sort() : [],
	idpRoles: JSON.parse(row.idp_roles),
	createdAt: row.created_at,
	lastSeenAt: row.last_seen_at ?? undefined,
});

const fromApiKeyRow = (row: ApiKeyRow): ApiKey => ({
	id: row.id,
	userId: row.user_id,
	label: row.label,
	hint: row.hint,
	createdAt: row.created_at,
	lastUsedAt: row.last_used_at ?? undefined,
});

// API keys are stored as their SHA-256, in hex; keys are long random
// secrets, so a plain hash suffices.
const apiKeyHash = (key: string): string =>
	new Bun.CryptoHasher('sha256').update(key).digest('hex');

const fromPermissionRow = (row: PermissionRow): Permission => ({
	holderType: row.holder_type,
	holderId: row.holder_id,
	backend: row.backend,
	tool: row.tool,
});

const USER_SELECT = `SELECT users.*, group_concat(user_roles.role_id) AS role_ids
	FROM users LEFT JOIN user_roles ON user_roles.user_id = users.id`;

const createAccessStore = (db: Database) => {
	const listUsersStmt = db.prepare<UserRow, []>(
		`${USER_SELECT} GROUP BY users.id ORDER BY coalesce(users.name, users.id)`,
	);
	const findUserStmt = db.prepare<UserRow, { userId: string }>(
		`${USER_SELECT} WHERE users.id = $userId GROUP BY users.id`,
	);
	const listRolesStmt = db.prepare<RoleRow, []>(
		'SELECT * FROM roles ORDER BY name',
	);
	const findRoleStmt = db.prepare<RoleRow, { id: string }>(
		'SELECT * FROM roles WHERE id = $id',
	);
	const findRoleByNameStmt = db.prepare<RoleRow, { name: string }>(
		'SELECT * FROM roles WHERE name = $name',
	);
	const listPermissionsStmt = db.prepare<PermissionRow, []>(
		'SELECT * FROM permissions ORDER BY backend, tool',
	);
	const userPermissionsStmt = db.prepare<PermissionRow, { userId: string }>(
		`SELECT * FROM permissions
		WHERE (holder_type = 'user' AND holder_id = $userId)
			OR (holder_type = 'role' AND holder_id IN
				(SELECT role_id FROM user_roles WHERE user_id = $userId))`,
	);
	const assignRolesStmt = db.prepare(
		`INSERT OR IGNORE INTO user_roles (user_id, role_id)
		SELECT $userId, id FROM roles WHERE name IN (SELECT value FROM json_each($roleNames))`,
	);
	const unassignRolesStmt = db.prepare(
		`DELETE FROM user_roles WHERE user_id = $userId
		AND role_id IN (SELECT id FROM roles WHERE name IN (SELECT value FROM json_each($roleNames)))`,
	);
	const deleteRoleUsersStmt = db.prepare(
		'DELETE FROM user_roles WHERE role_id = $roleId',
	);
	const insertUserRoleStmt = db.prepare(
		'INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES ($userId, $roleId)',
	);
	const insertUserStmt = db.prepare(
		`INSERT INTO users (id, realm, type, superadmin, name, username, enabled, created_at)
		VALUES ($userId, $realm, $type, $superadmin, $name, $username, $enabled, $createdAt)`,
	);
	const findSuperadminStmt = db.prepare<{ id: string }, []>(
		'SELECT id FROM users WHERE superadmin = 1',
	);
	const renameUserStmt = db.prepare(
		'UPDATE users SET name = $name, username = $name WHERE id = $userId',
	);
	const listKeysStmt = db.prepare<ApiKeyRow, []>(
		'SELECT * FROM api_keys ORDER BY created_at',
	);
	const findKeyStmt = db.prepare<ApiKeyRow, { hash: string }>(
		'SELECT * FROM api_keys WHERE hash = $hash',
	);
	const findKeyByIdStmt = db.prepare<ApiKeyRow, { id: string }>(
		'SELECT * FROM api_keys WHERE id = $id',
	);
	const insertKeyStmt = db.prepare(
		`INSERT INTO api_keys (id, user_id, label, hash, hint, created_at)
		VALUES ($id, $userId, $label, $hash, $hint, $createdAt)`,
	);
	const touchKeyStmt = db.prepare(
		'UPDATE api_keys SET last_used_at = $lastUsedAt WHERE id = $id',
	);
	const deleteKeyStmt = db.prepare('DELETE FROM api_keys WHERE id = $id');
	const updateUserStmt = db.prepare(
		'UPDATE users SET name = $name, username = $username, enabled = $enabled WHERE id = $userId',
	);
	const fillUserStmt = db.prepare(
		`UPDATE users SET name = coalesce(name, $name), username = coalesce(username, $username)
		WHERE id = $userId`,
	);
	const touchUserStmt = db.prepare(
		'UPDATE users SET last_seen_at = $lastSeenAt WHERE id = $userId',
	);
	const setIdpRolesStmt = db.prepare(
		'UPDATE users SET idp_roles = $idpRoles WHERE id = $userId',
	);
	const renameIdpRoleStmt = db.prepare(
		`UPDATE users SET idp_roles = (SELECT json_group_array(iif(value = $oldName, $newName, value))
			FROM json_each(users.idp_roles))
		WHERE $oldName IN (SELECT value FROM json_each(users.idp_roles))`,
	);
	const deleteUserStmt = db.prepare('DELETE FROM users WHERE id = $userId');
	const upsertRoleStmt = db.prepare(
		`INSERT INTO roles (id, name, created_at) VALUES ($id, $name, $createdAt)
		ON CONFLICT (id) DO UPDATE SET name = excluded.name`,
	);
	const addRoleStmt = db.prepare(
		`INSERT INTO roles (id, name, created_at) VALUES ($id, $name, $createdAt)
		ON CONFLICT (name) DO NOTHING`,
	);
	const deleteRoleStmt = db.prepare('DELETE FROM roles WHERE id = $id');
	const deleteHolderPermissionsStmt = db.prepare(
		'DELETE FROM permissions WHERE holder_type = $holderType AND holder_id = $holderId',
	);
	const insertPermissionStmt = db.prepare(
		'INSERT OR IGNORE INTO permissions (holder_type, holder_id, backend, tool) VALUES ($holderType, $holderId, $backend, $tool)',
	);

	const findUser = (userId: string): AccessUser | undefined => {
		const row = findUserStmt.get({
			userId,
		});
		return row ? fromUserRow(row) : undefined;
	};

	const knownUser = (userId: string): AccessUser => {
		const user = findUser(userId);
		if (!user) throw new UnknownIdError(`Unknown user ${userId}`);
		return user;
	};

	const knownHolder = (holderType: HolderType, holderId: string) => {
		if (holderType === 'user') knownUser(holderId);
		else if (
			!findRoleStmt.get({
				id: holderId,
			})
		)
			throw new UnknownIdError(`Unknown role ${holderId}`);
	};

	// Adds a user of the given realm and type (`create`) or changes one;
	// answers the user's ID. A Local user is a machine, gets a generated ID
	// and needs a Name; an OIDC user's ID is its IdP user ID, refused when
	// known. Empty names of OIDC users stay empty for tokens to fill. The
	// superadmin stays enabled and keeps the Name and Username it starts with.
	// Role memberships are saved with the role.
	const saveUser = db.transaction(
		(
			user: {
				id: string;
				name?: string;
				username?: string;
				enabled: boolean;
			} & ({ create: true; realm: Realm; type: UserType } | { create?: false }),
		): string => {
			const found = user.create ? undefined : knownUser(user.id);
			const realm = user.create ? user.realm : found?.realm;
			if (user.create && realm === 'local' && user.type !== 'machine')
				throw new ConflictError('A new Local user is a machine');
			const userId =
				user.create && realm === 'local' ? Bun.randomUUIDv7() : user.id;
			if (userId === '') throw new InvalidInputError('A User ID is needed');
			if (realm === 'local' && !user.name)
				throw new InvalidInputError('A Local user needs a Name');
			const values = {
				userId,
				name: user.name || null,
				username: user.username || null,
				enabled: user.enabled ? 1 : 0,
			};
			if (user.create) {
				if (findUser(userId))
					throw new ConflictError(`User ${userId} already exists`);
				insertUserStmt.run({
					...values,
					realm: user.realm,
					type: user.type,
					superadmin: 0,
					createdAt: Date.now(),
				});
				return userId;
			}
			if (found?.superadmin) {
				if (!user.enabled)
					throw new ConflictError('The superadmin cannot be disabled');
				if (
					(user.name || undefined) !== found.name ||
					(user.username || undefined) !== found.username
				)
					throw new ConflictError(
						'The superadmin is named by SUPERADMIN_USERNAME',
					);
			}
			updateUserStmt.run(values);
			return userId;
		},
	);

	// The superadmin's Local user, added on first start, with Name and Username
	// both SUPERADMIN_USERNAME.
	const ensureSuperadmin = (name: string): AccessUser => {
		const found = findSuperadminStmt.get();
		const userId = found?.id ?? Bun.randomUUIDv7();
		if (found)
			renameUserStmt.run({
				userId,
				name,
			});
		else {
			insertUserStmt.run({
				userId,
				realm: 'local',
				type: 'human',
				superadmin: 1,
				name,
				username: name,
				enabled: 1,
				createdAt: Date.now(),
			});
			logger.info(
				`Auth startup: ${logFields({
					op: 'add_superadmin',
					user_id: userId,
				})}`,
			);
		}
		return knownUser(userId);
	};

	// For convenience, roles named in a token that do not exist yet are added,
	// without permissions.
	const addRoles = (names: string[]) => {
		for (const name of names) {
			const id = Bun.randomUUIDv7();
			if (
				addRoleStmt.run({
					id,
					name,
					createdAt: Date.now(),
				}).changes > 0
			)
				logger.info(
					`Auth sync: ${logFields({
						op: 'add_role',
						role_id: id,
						role_name: name,
					})}`,
				);
		}
	};

	// The user's roles follow its latest token: the roles it names are assigned
	// (for convenience, unknown ones are added), and those the previous token
	// named but this one drops are unassigned. Tokens never remove roles.
	const syncRoles = (userId: string, previous: string[], names: string[]) => {
		const dropped = previous.filter((name) => !names.includes(name));
		if (
			unassignRolesStmt.run({
				userId,
				roleNames: JSON.stringify(dropped),
			}).changes > 0
		)
			logger.info(
				`Auth sync: ${logFields({
					op: 'unassign_roles',
					user_id: userId,
					// The latest token drops them.
					roles: dropped,
				})}`,
			);
		addRoles(names);
		assignRolesStmt.run({
			userId,
			roleNames: JSON.stringify(names),
		});
		setIdpRolesStmt.run({
			userId,
			idpRoles: JSON.stringify(names),
		});
	};

	// A sign-in through the IdP as the user with the token's user ID. For
	// convenience, an unknown one is added as an OIDC human, enabled and
	// without permissions; a machine's API key is registered with its user
	// first. An enabled OIDC user's empty names are filled from the token, its
	// roles follow the token's and it is last seen now. Disabled and Local
	// users are answered unchanged, for callers to refuse: Local users sign in
	// only at the gateway. Admins still manage users in the dashboard; tokens
	// never remove users.
	const signIn = db.transaction(
		(
			identity: {
				id: string;
				name?: string;
				username?: string;
				roles: string[];
			},
			now: number,
		): AccessUser => {
			const found = findUser(identity.id);
			if (found && (found.realm !== 'oidc' || !found.enabled)) return found;
			const values = {
				userId: identity.id,
				name: identity.name || null,
				username: identity.username || null,
			};
			if (found) fillUserStmt.run(values);
			else {
				insertUserStmt.run({
					...values,
					realm: 'oidc',
					type: 'human',
					superadmin: 0,
					enabled: 1,
					createdAt: now,
				});
				logger.info(
					`Auth sync: ${logFields({
						op: 'add_user',
						user_id: identity.id,
					})}`,
				);
			}
			syncRoles(identity.id, found?.idpRoles ?? [], identity.roles);
			touchUserStmt.run({
				userId: identity.id,
				lastSeenAt: now,
			});
			return knownUser(identity.id);
		},
	);

	const deleteHolder = db.transaction((holderType: HolderType, id: string) => {
		knownHolder(holderType, id);
		deleteHolderPermissionsStmt.run({
			holderType,
			holderId: id,
		});
		if (holderType === 'user')
			deleteUserStmt.run({
				userId: id,
			});
		else
			deleteRoleStmt.run({
				id,
			});
	});

	// Stores a new key's hash for a machine user; Local machines get keys
	// made by the gateway, OIDC machines register theirs.
	const addKey = (
		realm: Realm,
		key: {
			userId: string;
			label: string;
			hash: string;
			hint: string;
		},
	): ApiKey => {
		const user = knownUser(key.userId);
		if (user.type !== 'machine')
			throw new ConflictError('Only machine users have API keys');
		if (user.realm !== realm)
			throw new ConflictError(
				user.realm === 'local'
					? 'Only Local machines get keys made by the gateway'
					: 'Only OIDC machines register keys',
			);
		if (
			findKeyStmt.get({
				hash: key.hash,
			})
		)
			throw new ConflictError('This API key is already registered');
		const { hash, ...fields } = key;
		const apiKey = {
			...fields,
			id: Bun.randomUUIDv7(),
			createdAt: Date.now(),
		};
		insertKeyStmt.run({
			...apiKey,
			hash,
		});
		return apiKey;
	};

	return {
		listUsers: (): AccessUser[] => listUsersStmt.all().map(fromUserRow),
		listRoles: (): AccessState['roles'] =>
			listRolesStmt.all().map((row) => ({
				id: row.id,
				name: row.name,
				createdAt: row.created_at,
			})),
		listPermissions: (): Permission[] =>
			listPermissionsStmt.all().map(fromPermissionRow),
		findUser,
		// The user's own permissions plus those of its roles.
		accessOf: (userId: string): Access => {
			const rows = userPermissionsStmt.all({
				userId,
			});
			const backends = new Set(
				rows.filter((row) => row.tool === '').map((row) => row.backend),
			);
			const tools = new Set(
				rows
					.filter((row) => row.tool !== '')
					.map((row) => JSON.stringify([row.backend, row.tool])),
			);
			return {
				allowsBackend: (backend) => backends.has(backend),
				allowsTool: (backend, tool) =>
					tools.has(JSON.stringify([backend, tool])),
			};
		},
		saveUser,
		touchUser: (userId: string, lastSeenAt: number) => {
			touchUserStmt.run({
				userId,
				lastSeenAt,
			});
		},
		deleteUser: (userId: string) => {
			if (findUser(userId)?.superadmin)
				throw new ConflictError('The superadmin cannot be deleted');
			deleteHolder('user', userId);
		},
		ensureSuperadmin,
		signIn,
		listKeys: (): ApiKey[] => listKeysStmt.all().map(fromApiKeyRow),
		// The key with this hash, and its user.
		findKey: (hash: string): (ApiKey & { user: AccessUser }) | undefined => {
			const row = findKeyStmt.get({
				hash,
			});
			const user = row ? findUser(row.user_id) : undefined;
			return row && user
				? {
						...fromApiKeyRow(row),
						user,
					}
				: undefined;
		},
		// A new key for a Local machine, answered once; only its hash is kept.
		createKey: (key: {
			userId: string;
			label: string;
		}): { key: string; apiKey: ApiKey } => {
			const secret =
				LOCAL_KEY_PREFIX +
				Buffer.from(
					crypto.getRandomValues(new Uint8Array(LOCAL_KEY_BYTES)),
				).toString('base64url');
			return {
				key: secret,
				apiKey: addKey('local', {
					...key,
					hash: apiKeyHash(secret),
					hint: secret.slice(-KEY_HINT_LENGTH),
				}),
			};
		},
		// An OIDC machine's key, built elsewhere and known by its hash.
		registerKey: (key: {
			userId: string;
			label: string;
			hash: string;
			hint: string;
		}): ApiKey => addKey('oidc', key),
		touchKey: (id: string, lastUsedAt: number) => {
			touchKeyStmt.run({
				id,
				lastUsedAt,
			});
		},
		// Revokes the key; answers it.
		deleteKey: (id: string): ApiKey => {
			const row = findKeyByIdStmt.get({
				id,
			});
			if (!row) throw new UnknownIdError(`Unknown API key ${id}`);
			deleteKeyStmt.run({
				id,
			});
			return fromApiKeyRow(row);
		},
		// Upserts the role and replaces the users it is assigned to. A renamed
		// role is renamed in the users' IdP roles too, so a later token that
		// drops it still unassigns it.
		saveRole: db.transaction(
			(role: { id?: string; name: string; userIds: string[] }): string => {
				const id = role.id ?? Bun.randomUUIDv7();
				const named = findRoleByNameStmt.get({
					name: role.name,
				});
				if (named && named.id !== id)
					throw new ConflictError(`A role is named ${role.name} already`);
				for (const userId of role.userIds) knownUser(userId);
				const oldName = findRoleStmt.get({
					id,
				})?.name;
				if (oldName !== undefined && oldName !== role.name)
					renameIdpRoleStmt.run({
						oldName,
						newName: role.name,
					});
				upsertRoleStmt.run({
					id,
					name: role.name,
					createdAt: Date.now(),
				});
				deleteRoleUsersStmt.run({
					roleId: id,
				});
				for (const userId of role.userIds)
					insertUserRoleStmt.run({
						userId,
						roleId: id,
					});
				return id;
			},
		),
		deleteRole: (id: string) => deleteHolder('role', id),
		// Replaces all permissions of one user or role.
		savePermissions: db.transaction(
			(
				holder: Pick<Permission, 'holderType' | 'holderId'>,
				grants: Pick<Permission, 'backend' | 'tool'>[],
			) => {
				knownHolder(holder.holderType, holder.holderId);
				deleteHolderPermissionsStmt.run(holder);
				for (const grant of grants)
					insertPermissionStmt.run({
						...holder,
						...grant,
					});
			},
		),
	};
};

type AccessStore = ReturnType<typeof createAccessStore>;

export type { Access, AccessStore, AccessUser };
export {
	apiKeyHash,
	ConflictError,
	createAccessStore,
	InvalidInputError,
	UnknownIdError,
};
