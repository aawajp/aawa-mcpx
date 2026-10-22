import { createAccessRoutes } from '@/server/auth/access_routes';
import { apiKeyHash, createAccessStore } from '@/server/db/access';
import { openMainDatabase } from '@/server/db/main';
import { logger } from '@/server/logger';
import {
	ACCESS_PATHS,
	accessStateType,
	apiErrorType,
	createdKeyResponseType,
	LOCAL_KEY_PREFIX,
} from '@/shared/ui_api';

import { expect, spyOn, test } from 'bun:test';

const setUp = () => {
	const access = createAccessStore(openMainDatabase(':memory:'));
	const routes = createAccessRoutes(access, {
		adminIdOf: () => 'admin-subject',
		endSessions: () => 0,
	});
	const call = (
		path: Exclude<keyof typeof ACCESS_PATHS, 'state'>,
		body: unknown,
	) =>
		routes[ACCESS_PATHS[path]].POST(
			new Request(`http://localhost${ACCESS_PATHS[path]}`, {
				method: 'POST',
				body: JSON.stringify(body),
			}),
		);
	return {
		access,
		call,
	};
};

test('every Auth tab change is logged with the admin who made it', async () => {
	const { access, call } = setUp();
	const info = spyOn(logger, 'info').mockImplementation(() => undefined);
	const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);

	await call('saveUser', {
		id: 'bot-subject',
		enabled: true,
		create: true,
		realm: 'oidc',
		type: 'human',
	});
	// The role holds its users.
	await call('saveRole', {
		name: 'ops',
		userIds: ['bot-subject'],
	});
	const opsId = access.listRoles()[0]?.id ?? '';
	expect(access.findUser('bot-subject')?.roleIds).toEqual([opsId]);
	await call('savePermissions', {
		holderType: 'role',
		holderId: opsId,
		grants: [
			{
				backend: 'alpha',
				tool: '',
			},
			{
				backend: 'alpha',
				tool: 'deploy',
			},
		],
	});
	expect(
		(
			await call('saveUser', {
				id: 'bot-subject',
				enabled: true,
				create: true,
				realm: 'oidc',
				type: 'human',
			})
		).status,
	).toBe(409);
	await call('deleteRole', {
		id: opsId,
	});
	await call('deleteUser', {
		id: 'bot-subject',
	});

	expect(info.mock.calls.map(([line]) => line)).toEqual([
		'Auth admin: op=save_user admin_id=admin-subject user_id=bot-subject realm=oidc type=human created=true enabled=true',
		`Auth admin: op=save_role admin_id=admin-subject role_id=${opsId} role_name=ops created=true user_ids=[bot-subject]`,
		`Auth admin: op=save_permissions admin_id=admin-subject holder_type=role holder_id=${opsId} role_name=ops grants=[alpha,alpha/deploy]`,
		`Auth admin: op=delete_role admin_id=admin-subject role_id=${opsId} role_name=ops`,
		'Auth admin: op=delete_user admin_id=admin-subject user_id=bot-subject ended_sessions=0',
	]);
	expect(warn.mock.calls[0]?.[0]).toBe(
		'Auth admin failed: op=save_user admin_id=admin-subject status=409 error="User bot-subject already exists"',
	);
	info.mockRestore();
	warn.mockRestore();
});

test('Local users get keys from the gateway, OIDC service accounts register theirs', async () => {
	const { access, call } = setUp();
	const info = spyOn(logger, 'info').mockImplementation(() => undefined);
	const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
	const state = accessStateType.assert(
		await (
			await call('saveUser', {
				id: '',
				name: 'Local bot',
				enabled: true,
				create: true,
				realm: 'local',
				type: 'machine',
			})
		).json(),
	);
	const localId = state.users[0]?.id ?? '';
	expect(state.users[0]?.realm).toBe('local');
	// A Local user needs a Name.
	expect(
		(
			await call('saveUser', {
				id: '',
				enabled: true,
				create: true,
				realm: 'local',
				type: 'machine',
			})
		).status,
	).toBe(400);

	const created = createdKeyResponseType.assert(
		await (
			await call('createKey', {
				userId: localId,
				label: 'ci',
			})
		).json(),
	);
	expect(created.key).toStartWith(LOCAL_KEY_PREFIX);
	const [localKey] = created.apiKeys;
	expect(localKey).toMatchObject({
		userId: localId,
		label: 'ci',
		hint: created.key.slice(-4),
	});
	expect(access.findKey(apiKeyHash(created.key))?.id).toBe(localKey?.id);
	// The key itself is never kept or logged.
	expect(JSON.stringify(created.apiKeys)).not.toContain(created.key);
	expect(JSON.stringify(info.mock.calls)).not.toContain(created.key);

	await call('saveUser', {
		id: 'bot-client',
		username: 'bot-client',
		enabled: true,
		create: true,
		realm: 'oidc',
		type: 'machine',
	});
	await call('saveUser', {
		id: 'person',
		enabled: true,
		create: true,
		realm: 'oidc',
		type: 'human',
	});
	const hash = apiKeyHash('sk_aawa_api01_built-in-browser');
	expect(
		(
			await call('registerKey', {
				userId: 'bot-client',
				label: 'claude',
				hash,
				hint: 'wser',
			})
		).status,
	).toBe(200);
	expect(access.findKey(hash)?.user.id).toBe('bot-client');
	// A new Local user is a machine.
	expect(
		(
			await call('saveUser', {
				id: '',
				name: 'person',
				enabled: true,
				create: true,
				realm: 'local',
				type: 'human',
			})
		).status,
	).toBe(409);
	// Each realm's machines get keys only its own way; humans, the superadmin
	// too, get none.
	const superadminId = access.ensureSuperadmin('root').id;
	for (const [path, body] of [
		[
			'createKey',
			{
				userId: superadminId,
				label: '',
			},
		],
		[
			'createKey',
			{
				userId: 'bot-client',
				label: '',
			},
		],
		[
			'createKey',
			{
				userId: 'person',
				label: '',
			},
		],
		[
			'registerKey',
			{
				userId: localId,
				label: '',
				hash: apiKeyHash('other'),
				hint: 'ther',
			},
		],
		[
			'registerKey',
			{
				userId: 'person',
				label: '',
				hash: apiKeyHash('another'),
				hint: 'ther',
			},
		],
	] as const)
		expect((await call(path, body)).status).toBe(409);
	expect(
		(
			await call('registerKey', {
				userId: 'bot-client',
				label: '',
				hash: 'not-a-hash',
				hint: 'abcd',
			})
		).status,
	).toBe(400);

	await call('revokeKey', {
		id: localKey?.id,
	});
	expect(access.findKey(apiKeyHash(created.key))).toBeUndefined();
	expect(
		(
			await call('revokeKey', {
				id: localKey?.id,
			})
		).status,
	).toBe(404);
	// Deleting a user deletes its keys.
	await call('deleteUser', {
		id: 'bot-client',
	});
	expect(access.listKeys()).toEqual([]);
	expect(
		info.mock.calls
			.map(([line]) => String(line))
			.filter((line) => line.includes('_key ')),
	).toEqual([
		`Auth admin: op=create_key admin_id=admin-subject user_id=${localId} key_id=${localKey?.id} label=ci`,
		expect.stringMatching(
			/^Auth admin: op=register_key admin_id=admin-subject user_id=bot-client key_id=\S+ label=claude$/,
		),
		`Auth admin: op=revoke_key admin_id=admin-subject user_id=${localId} key_id=${localKey?.id} label=ci`,
	]);
	info.mockRestore();
	warn.mockRestore();
});

test('the superadmin can be neither deleted, disabled nor renamed', async () => {
	const { access, call } = setUp();
	const superadmin = access.ensureSuperadmin('root');
	expect(superadmin).toMatchObject({
		realm: 'local',
		superadmin: true,
		name: 'root',
		enabled: true,
	});
	// A changed SUPERADMIN_USERNAME renames the same user.
	expect(access.ensureSuperadmin('admin').id).toBe(superadmin.id);
	expect(access.findUser(superadmin.id)).toMatchObject({
		name: 'admin',
		username: 'admin',
	});
	const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
	const info = spyOn(logger, 'info').mockImplementation(() => undefined);
	expect(
		(
			await call('deleteUser', {
				id: superadmin.id,
			})
		).status,
	).toBe(409);
	expect(
		(
			await call('saveUser', {
				id: superadmin.id,
				name: 'admin',
				username: 'admin',
				enabled: false,
			})
		).status,
	).toBe(409);
	expect(
		(
			await call('saveUser', {
				id: superadmin.id,
				name: 'root',
				username: 'admin',
				enabled: true,
			})
		).status,
	).toBe(409);
	expect(
		(
			await call('saveUser', {
				id: superadmin.id,
				name: 'admin',
				username: 'admin',
				enabled: true,
			})
		).status,
	).toBe(200);
	expect(access.findUser(superadmin.id)?.enabled).toBe(true);
	warn.mockRestore();
	info.mockRestore();
});

test('refusals answer with the status of their cause', async () => {
	const { access, call } = setUp();
	const warn = spyOn(logger, 'warn').mockImplementation(() => undefined);
	const info = spyOn(logger, 'info').mockImplementation(() => undefined);
	const roleId = access.saveRole({
		name: 'ops',
		userIds: [],
	});
	const answers = async (
		path: Parameters<typeof call>[0],
		body: unknown,
	): Promise<[number, string]> => {
		const response = await call(path, body);
		return [response.status, apiErrorType.assert(await response.json()).error];
	};
	// The body's shape.
	expect(
		(
			await answers('saveRole', {
				name: ' ',
				userIds: [],
			})
		)[0],
	).toBe(400);
	// Input the store cannot use.
	expect(
		await answers('saveUser', {
			id: '',
			enabled: true,
			create: true,
			realm: 'oidc',
			type: 'human',
		}),
	).toEqual([400, 'A User ID is needed']);
	// Unknown IDs.
	for (const [path, body, message] of [
		[
			'saveUser',
			{
				id: 'nobody',
				enabled: true,
			},
			'Unknown user nobody',
		],
		[
			'deleteUser',
			{
				id: 'nobody',
			},
			'Unknown user nobody',
		],
		[
			'deleteRole',
			{
				id: 'no-role',
			},
			'Unknown role no-role',
		],
		[
			'saveRole',
			{
				name: 'auditors',
				userIds: ['nobody'],
			},
			'Unknown user nobody',
		],
		[
			'savePermissions',
			{
				holderType: 'user',
				holderId: 'nobody',
				grants: [],
			},
			'Unknown user nobody',
		],
		[
			'savePermissions',
			{
				holderType: 'role',
				holderId: 'no-role',
				grants: [],
			},
			'Unknown role no-role',
		],
		[
			'createKey',
			{
				userId: 'nobody',
				label: '',
			},
			'Unknown user nobody',
		],
		[
			'revokeKey',
			{
				id: 'no-key',
			},
			'Unknown API key no-key',
		],
	] as const)
		expect(await answers(path, body)).toEqual([404, message]);
	// Conflicts with existing data.
	expect(
		await answers('saveRole', {
			name: 'ops',
			userIds: [],
		}),
	).toEqual([409, 'A role is named ops already']);
	expect(
		(
			await call('saveRole', {
				id: roleId,
				name: 'ops',
				userIds: [],
			})
		).status,
	).toBe(200);
	expect(access.listPermissions()).toEqual([]);
	warn.mockRestore();
	info.mockRestore();
});
