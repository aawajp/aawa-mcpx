import { type } from 'arktype';

import type { UiAuth } from '@/server/auth/ui_auth';
import {
	type AccessStore,
	ConflictError,
	InvalidInputError,
	UnknownIdError,
} from '@/server/db/access';
import { jsonError, readBody } from '@/server/gateway/http';
import { type LogField, logFields, logger } from '@/server/logger';
import { errorMessage } from '@/shared/common';
import {
	ACCESS_PATHS,
	KEY_HINT_LENGTH,
	REALMS,
	USER_TYPES,
} from '@/shared/ui_api';

const userFields = {
	'+': 'reject',
	// Empty for a new Local user, which gets a generated ID.
	id: 'string.trim',
	'name?': 'string.trim',
	'username?': 'string.trim',
	enabled: 'boolean',
} as const;

// `create` adds a user of a realm and type and refuses a known ID; otherwise
// the user must exist, and keeps its realm and type. Role memberships are
// saved with the role.
const saveUserBodyType = type({
	...userFields,
	create: 'true',
	realm: type.enumerated(...REALMS),
	type: type.enumerated(...USER_TYPES),
}).or({
	...userFields,
	'create?': 'false',
});

const saveRoleBodyType = type({
	'+': 'reject',
	'id?': 'string',
	name: 'string.trim |> string > 0',
	userIds: 'string[]',
});

const idBodyType = type({
	'+': 'reject',
	id: 'string',
});

const savePermissionsBodyType = type({
	'+': 'reject',
	holderType: "'user' | 'role'",
	holderId: 'string',
	grants: type({
		'+': 'reject',
		backend: 'string > 0',
		// Empty for the backend permission.
		tool: 'string',
	}).array(),
});

const createKeyBodyType = type({
	'+': 'reject',
	userId: 'string',
	label: 'string.trim',
});

// An OIDC service account's key is built in the browser, which sends only its
// hash, so the secret never passes the dashboard API.
const registerKeyBodyType = type({
	'+': 'reject',
	userId: 'string',
	label: 'string.trim',
	hash: /^[0-9a-f]{64}$/,
	hint: `string == ${KEY_HINT_LENGTH}`,
});

// What a change did, for the log, and what the answer adds to the state.
type Change = {
	log: Record<string, LogField>;
	reply?: Record<string, unknown>;
};

// Dashboard API for MCP client users, roles, permissions and API keys. Every
// change answers with the whole state, like the other dashboard actions, and
// is logged with the admin who made it.
const createAccessRoutes = (
	access: AccessStore,
	ui: Pick<UiAuth, 'adminIdOf' | 'endSessions'>,
) => {
	const state = (reply?: Record<string, unknown>) =>
		Response.json({
			users: access.listUsers(),
			roles: access.listRoles(),
			permissions: access.listPermissions(),
			apiKeys: access.listKeys(),
			...reply,
		});

	const roleName = (roleId: string) =>
		access.listRoles().find((role) => role.id === roleId)?.name;

	// The store's refusals keep their meaning; anything else is a fault.
	const statusOf = (error: unknown) =>
		error instanceof InvalidInputError
			? 400
			: error instanceof UnknownIdError
				? 404
				: error instanceof ConflictError
					? 409
					: 500;

	const post =
		<T>(
			op: string,
			bodyType: { assert: (value: unknown) => T },
			action: (body: T) => Change,
		) =>
		async (request: Request): Promise<Response> => {
			const body = await readBody(bodyType, request);
			if (body instanceof Response) return body;
			const by = {
				op,
				admin_id: ui.adminIdOf(request),
			};
			let change: Change;
			try {
				change = action(body);
			} catch (error) {
				const status = statusOf(error);
				logger.warn(
					`Auth admin failed: ${logFields({
						...by,
						status,
						error: errorMessage(error),
					})}`,
				);
				return jsonError(status, errorMessage(error));
			}
			logger.info(
				`Auth admin: ${logFields({
					...by,
					...change.log,
				})}`,
			);
			return state(change.reply);
		};

	return {
		[ACCESS_PATHS.state]: {
			GET: () => state(),
		},
		[ACCESS_PATHS.saveUser]: {
			POST: post('save_user', saveUserBodyType, (body) => {
				const userId = access.saveUser(body);
				const user = access.findUser(userId);
				return {
					log: {
						user_id: userId,
						realm: user?.realm,
						type: user?.type,
						created: body.create === true,
						enabled: body.enabled,
						...(body.enabled
							? {}
							: {
									ended_sessions: ui.endSessions(userId),
								}),
					},
				};
			}),
		},
		[ACCESS_PATHS.deleteUser]: {
			POST: post('delete_user', idBodyType, (body) => {
				access.deleteUser(body.id);
				return {
					log: {
						user_id: body.id,
						ended_sessions: ui.endSessions(body.id),
					},
				};
			}),
		},
		[ACCESS_PATHS.saveRole]: {
			POST: post('save_role', saveRoleBodyType, (body) => ({
				log: {
					role_id: access.saveRole(body),
					role_name: body.name,
					created: body.id === undefined,
					user_ids: body.userIds,
				},
			})),
		},
		[ACCESS_PATHS.deleteRole]: {
			POST: post('delete_role', idBodyType, (body) => {
				const name = roleName(body.id);
				access.deleteRole(body.id);
				return {
					log: {
						role_id: body.id,
						role_name: name,
					},
				};
			}),
		},
		[ACCESS_PATHS.savePermissions]: {
			POST: post(
				'save_permissions',
				savePermissionsBodyType,
				({ grants, ...holder }) => {
					access.savePermissions(holder, grants);
					return {
						log: {
							holder_type: holder.holderType,
							// A user ID, or a role ID with its name.
							holder_id: holder.holderId,
							...(holder.holderType === 'role' && {
								role_name: roleName(holder.holderId),
							}),
							// `backend` for the backend permission, `backend/tool` for a tool.
							grants: grants.map(({ backend, tool }) =>
								tool === '' ? backend : `${backend}/${tool}`,
							),
						},
					};
				},
			),
		},
		// A new key for a Local machine: shown once in the answer, stored as a
		// hash.
		[ACCESS_PATHS.createKey]: {
			POST: post('create_key', createKeyBodyType, (body) => {
				const { key, apiKey } = access.createKey(body);
				return {
					log: {
						user_id: body.userId,
						key_id: apiKey.id,
						label: body.label,
					},
					reply: {
						key,
					},
				};
			}),
		},
		[ACCESS_PATHS.registerKey]: {
			POST: post('register_key', registerKeyBodyType, (body) => {
				const saved = access.registerKey(body);
				return {
					log: {
						user_id: body.userId,
						key_id: saved.id,
						label: body.label,
					},
				};
			}),
		},
		[ACCESS_PATHS.revokeKey]: {
			POST: post('revoke_key', idBodyType, (body) => {
				const revoked = access.deleteKey(body.id);
				return {
					log: {
						user_id: revoked.userId,
						key_id: body.id,
						label: revoked.label,
					},
				};
			}),
		},
	};
};

export { createAccessRoutes };
