import {
	apiKeyHash,
	ConflictError,
	createAccessStore,
	InvalidInputError,
	UnknownIdError,
} from '@/server/db/access';
import { openMainDatabase } from '@/server/db/main';
import { KEY_HINT_LENGTH, LOCAL_KEY_PREFIX } from '@/shared/ui_api';

import { expect, test } from 'bun:test';

const setUp = () => createAccessStore(openMainDatabase(':memory:'));

// A registered key's fields, as the dashboard sends them.
const keyOf = (userId: string, key: string) => ({
	userId,
	label: 'test',
	hash: apiKeyHash(key),
	hint: key.slice(-KEY_HINT_LENGTH),
});

test('a new Local user is a machine with a generated ID and a Name', () => {
	const access = setUp();
	const localId = access.saveUser({
		id: 'ignored',
		name: 'Local bot',
		enabled: true,
		create: true,
		realm: 'local',
		type: 'machine',
	});
	expect(localId).not.toBe('ignored');
	expect(access.findUser(localId)).toMatchObject({
		realm: 'local',
		type: 'machine',
		superadmin: false,
	});
	expect(() =>
		access.saveUser({
			id: '',
			name: 'person',
			enabled: true,
			create: true,
			realm: 'local',
			type: 'human',
		}),
	).toThrow(ConflictError);
	for (const save of [
		() =>
			access.saveUser({
				id: '',
				enabled: true,
				create: true,
				realm: 'local',
				type: 'machine',
			}),
		() =>
			access.saveUser({
				id: localId,
				enabled: true,
			}),
	])
		expect(save).toThrow(new InvalidInputError('A Local user needs a Name'));
});

test('an OIDC user needs a new user ID, and only known users change', () => {
	const access = setUp();
	const user = {
		id: 'alice-subject',
		enabled: true,
		create: true,
		realm: 'oidc',
		type: 'human',
	} as const;
	expect(access.saveUser(user)).toBe('alice-subject');
	expect(() => access.saveUser(user)).toThrow(ConflictError);
	expect(() =>
		access.saveUser({
			...user,
			id: '',
		}),
	).toThrow(InvalidInputError);
	expect(() =>
		access.saveUser({
			id: 'nobody',
			enabled: true,
		}),
	).toThrow(new UnknownIdError('Unknown user nobody'));
	// Empty names stay empty, for tokens to fill.
	access.saveUser({
		id: 'alice-subject',
		name: '',
		enabled: false,
	});
	expect(access.findUser('alice-subject')).toMatchObject({
		name: undefined,
		enabled: false,
		realm: 'oidc',
		type: 'human',
	});
});

test('the superadmin is a Local human that keeps its name, stays enabled and gets no keys', () => {
	const access = setUp();
	const superadmin = access.ensureSuperadmin('root');
	expect(superadmin).toMatchObject({
		realm: 'local',
		type: 'human',
		superadmin: true,
		name: 'root',
		username: 'root',
	});
	for (const change of [
		() => access.deleteUser(superadmin.id),
		() =>
			access.saveUser({
				id: superadmin.id,
				name: 'root',
				username: 'root',
				enabled: false,
			}),
		() =>
			access.saveUser({
				id: superadmin.id,
				name: 'admin',
				username: 'root',
				enabled: true,
			}),
		() =>
			access.createKey({
				userId: superadmin.id,
				label: '',
			}),
	])
		expect(change).toThrow(ConflictError);
	expect(access.findUser(superadmin.id)).toEqual(superadmin);
});

test('only machines get keys, each realm its own way', () => {
	const access = setUp();
	const localId = access.saveUser({
		id: '',
		name: 'Local bot',
		enabled: true,
		create: true,
		realm: 'local',
		type: 'machine',
	});
	for (const [id, type] of [
		['oidc-bot', 'machine'],
		['person', 'human'],
	] as const)
		access.saveUser({
			id,
			enabled: true,
			create: true,
			realm: 'oidc',
			type,
		});
	const created = access.createKey({
		userId: localId,
		label: 'ci',
	});
	expect(created.key).toStartWith(LOCAL_KEY_PREFIX);
	expect(access.findKey(apiKeyHash(created.key))?.id).toBe(created.apiKey.id);
	const registered = access.registerKey(keyOf('oidc-bot', 'sk_aawa_api01_x'));
	expect(access.findKey(apiKeyHash('sk_aawa_api01_x'))?.user.id).toBe(
		'oidc-bot',
	);
	for (const [add, message] of [
		[
			() =>
				access.createKey({
					userId: 'oidc-bot',
					label: '',
				}),
			'Only OIDC machines register keys',
		],
		[
			() => access.registerKey(keyOf(localId, 'other')),
			'Only Local machines get keys made by the gateway',
		],
		[
			() => access.registerKey(keyOf('person', 'another')),
			'Only machine users have API keys',
		],
		[
			() => access.registerKey(keyOf('oidc-bot', 'sk_aawa_api01_x')),
			'This API key is already registered',
		],
	] as const)
		expect(add).toThrow(new ConflictError(message));
	expect(() => access.registerKey(keyOf('nobody', 'more'))).toThrow(
		UnknownIdError,
	);
	expect(access.deleteKey(registered.id).id).toBe(registered.id);
	expect(() => access.deleteKey(registered.id)).toThrow(UnknownIdError);
});

test('unknown holders and taken role names are refused', () => {
	const access = setUp();
	const roleId = access.saveRole({
		name: 'ops',
		userIds: [],
	});
	for (const change of [
		() => access.deleteUser('nobody'),
		() => access.deleteRole('no-role'),
		() =>
			access.savePermissions(
				{
					holderType: 'user',
					holderId: 'nobody',
				},
				[],
			),
		() =>
			access.savePermissions(
				{
					holderType: 'role',
					holderId: 'no-role',
				},
				[],
			),
		() =>
			access.saveRole({
				id: roleId,
				name: 'ops',
				userIds: ['nobody'],
			}),
	])
		expect(change).toThrow(UnknownIdError);
	expect(() =>
		access.saveRole({
			name: 'ops',
			userIds: [],
		}),
	).toThrow(ConflictError);
	// A refused change leaves everything as it was.
	expect(access.listRoles().map((role) => role.name)).toEqual(['ops']);
	expect(access.listUsers()).toEqual([]);
});

test('a sign-in adds or fills OIDC users only, and follows the IdP roles while enabled', () => {
	const access = setUp();
	const now = Date.now();
	// An unknown user ID becomes an OIDC human, its roles added.
	const added = access.signIn(
		{
			id: 'newcomer',
			name: 'Newcomer',
			roles: ['ops'],
		},
		now,
	);
	expect(added).toMatchObject({
		realm: 'oidc',
		type: 'human',
		enabled: true,
		name: 'Newcomer',
		username: undefined,
		idpRoles: ['ops'],
		lastSeenAt: now,
	});
	const opsId = access.listRoles()[0]?.id;
	expect(added.roleIds).toEqual([opsId ?? '']);
	// Names are filled, never overwritten; a dropped role is unassigned.
	expect(
		access.signIn(
			{
				id: 'newcomer',
				name: 'Other',
				username: 'newcomer-login',
				roles: [],
			},
			now + 1,
		),
	).toMatchObject({
		name: 'Newcomer',
		username: 'newcomer-login',
		roleIds: [],
		idpRoles: [],
		lastSeenAt: now + 1,
	});
	// A disabled user and a Local user with the same ID stay as they are.
	access.saveUser({
		id: 'newcomer',
		name: 'Newcomer',
		enabled: false,
	});
	const localId = access.saveUser({
		id: '',
		name: 'Local bot',
		enabled: true,
		create: true,
		realm: 'local',
		type: 'machine',
	});
	const before = access.listUsers();
	expect(
		['newcomer', localId].map((id) => {
			const user = access.signIn(
				{
					id,
					name: 'Token name',
					username: 'token-login',
					roles: ['ops'],
				},
				now + 2,
			);
			return [user.realm, user.enabled];
		}),
	).toEqual([
		['oidc', false],
		['local', true],
	]);
	expect(access.listUsers()).toEqual(before);
});

test('renaming a role renames it in the IdP roles, so tokens keep following them', () => {
	const access = setUp();
	const now = Date.now();
	for (const id of ['alice', 'bob'])
		access.signIn(
			{
				id,
				roles: ['ops', 'dev'],
			},
			now,
		);
	const opsId = access.listRoles().find((role) => role.name === 'ops')?.id;
	access.saveRole({
		id: opsId,
		name: 'operators',
		userIds: ['alice', 'bob'],
	});
	expect(access.findUser('alice')?.idpRoles).toEqual(['operators', 'dev']);
	// A token that drops the role unassigns it.
	expect(
		access.signIn(
			{
				id: 'alice',
				roles: ['dev'],
			},
			now + 1,
		).roleIds,
	).not.toContain(opsId);
	// A token that still names the old key unassigns it and gets a new role.
	const bob = access.signIn(
		{
			id: 'bob',
			roles: ['ops', 'dev'],
		},
		now + 1,
	);
	const newOpsId = access.listRoles().find((role) => role.name === 'ops')?.id;
	expect(newOpsId).not.toBe(opsId);
	expect(bob.roleIds).not.toContain(opsId);
	expect(bob.roleIds).toContain(newOpsId ?? '');
});

test('a role assigned in the dashboard and named by a token follows the IdP', () => {
	const access = setUp();
	const now = Date.now();
	access.signIn(
		{
			id: 'alice',
			roles: [],
		},
		now,
	);
	const ops = access.saveRole({
		name: 'ops',
		userIds: ['alice'],
	});
	const manual = access.saveRole({
		name: 'manual',
		userIds: ['alice'],
	});
	const signIn = (roles: string[]) =>
		access
			.signIn(
				{
					id: 'alice',
					roles,
				},
				now,
			)
			.roleIds.toSorted();
	expect(signIn(['ops'])).toEqual([manual, ops].toSorted());
	expect(signIn([])).toEqual([manual]);
});

test('assigned roles count, and deleting a role removes its assignments and permissions', () => {
	const access = setUp();
	const role = access.saveRole({
		name: 'temporary',
		userIds: [],
	});
	const user = 'dave-id';
	access.saveUser({
		id: user,
		enabled: true,
		create: true,
		realm: 'oidc',
		type: 'human',
	});
	access.savePermissions(
		{
			holderType: 'role',
			holderId: role,
		},
		[
			{
				backend: 'beta',
				tool: '',
			},
		],
	);
	expect(access.accessOf(user).allowsBackend('beta')).toBe(false);
	access.saveRole({
		id: role,
		name: 'temporary',
		userIds: [user],
	});
	expect(access.accessOf(user).allowsBackend('beta')).toBe(true);
	expect(
		access.listUsers().find((entry) => entry.id === user)?.roleIds,
	).toEqual([role]);
	access.deleteRole(role);
	expect(
		access.listUsers().find((entry) => entry.id === user)?.roleIds,
	).toEqual([]);
	expect(access.accessOf(user).allowsBackend('beta')).toBe(false);
	expect(access.listPermissions()).not.toContainEqual(
		expect.objectContaining({
			holderId: role,
		}),
	);
});

test('saving upserts by ID and replaces a holder permissions', () => {
	const access = setUp();
	const role = access.saveRole({
		id: 'role-id',
		name: 'readers',
		userIds: [],
	});
	expect(role).toBe('role-id');
	access.saveRole({
		id: role,
		name: 'viewers',
		userIds: [],
	});
	expect(access.listRoles().find((entry) => entry.id === role)?.name).toBe(
		'viewers',
	);
	const holder = {
		holderType: 'role' as const,
		holderId: role,
	};
	access.savePermissions(holder, [
		{
			backend: 'alpha',
			tool: 'read',
		},
		{
			backend: 'beta',
			tool: '',
		},
	]);
	access.savePermissions(holder, [
		{
			backend: 'alpha',
			tool: 'write',
		},
	]);
	expect(
		access
			.listPermissions()
			.filter((permission) => permission.holderId === role)
			.map((permission) => permission.tool),
	).toEqual(['write']);
});
