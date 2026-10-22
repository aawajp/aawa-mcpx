import { useEffect, useState } from 'react';

import { errorMessage } from '@/shared/common';
import {
	ACCESS_PATHS,
	type AccessState,
	AUTH_PATHS,
	accessStateType,
	type BackendOverview,
	loginMethodsType,
	userLabel,
} from '@/shared/ui_api';
import { getJson, postJson, useRequest } from '@/ui/api/client';
import { t } from '@/ui/i18n';
import type { Realm } from '@/ui/sections/auth/common';
import { ApiKeysCard } from '@/ui/sections/auth/keys';
import { PermissionsCard } from '@/ui/sections/auth/permissions';
import { RolesCard } from '@/ui/sections/auth/roles';
import { UsersCard } from '@/ui/sections/auth/users';

const AuthSection = ({ backends }: { backends: BackendOverview[] }) => {
	const [state, setState] = useState<AccessState | null>(null);
	const { pending, error, setError, run } = useRequest();
	// New users are Local unless OIDC is on.
	const [newRealm, setNewRealm] = useState<Realm>('local');

	useEffect(() => {
		void getJson(ACCESS_PATHS.state)
			.then((data) => setState(accessStateType.assert(data)))
			.catch((err) => setError(errorMessage(err)));
		void getJson(AUTH_PATHS.methods)
			.then((data) => {
				if (loginMethodsType.assert(data).oidc) setNewRealm('oidc');
			})
			.catch((err) => setError(errorMessage(err)));
	}, [setError]);

	if (!state) return error ? <p className="text-rose-300">{error}</p> : null;

	const act = (path: string, body: unknown) =>
		run(async () =>
			setState(accessStateType.assert(await postJson(path, body))),
		);
	// Deleting and revoking cannot be undone, so they ask first.
	const confirmAct = (question: string, path: string, id: string) => {
		if (window.confirm(question))
			void act(path, {
				id,
			});
	};

	return (
		<section className="grid w-max min-w-full gap-3">
			<h2 className="text-2xl font-semibold">{t('auth.title')}</h2>
			{error ? <p className="text-rose-300">{error}</p> : null}

			<UsersCard
				state={state}
				newRealm={newRealm}
				pending={pending}
				// A new user is created in its realm and type; a saved one keeps them.
				onSave={({ realm, type, ...draft }, create) =>
					act(
						ACCESS_PATHS.saveUser,
						create
							? {
									...draft,
									create,
									realm,
									type,
								}
							: draft,
					)
				}
				onDelete={(user) =>
					confirmAct(
						`${t('auth.delete')} ${userLabel(user)}?`,
						ACCESS_PATHS.deleteUser,
						user.id,
					)
				}
				onState={setState}
			/>

			<RolesCard
				state={state}
				pending={pending}
				onSave={(id, draft) =>
					act(ACCESS_PATHS.saveRole, {
						id,
						...draft,
					})
				}
				onDelete={(role) =>
					confirmAct(
						`${t('auth.delete')} ${role.name}?`,
						ACCESS_PATHS.deleteRole,
						role.id,
					)
				}
			/>

			<ApiKeysCard
				state={state}
				pending={pending}
				onRevoke={(key) =>
					confirmAct(
						`${t('auth.confirmRevoke')} ${key.id}?`,
						ACCESS_PATHS.revokeKey,
						key.id,
					)
				}
			/>

			<PermissionsCard
				state={state}
				backends={backends}
				pending={pending}
				onSave={(holder, grants) =>
					act(ACCESS_PATHS.savePermissions, {
						holderType: holder.type,
						holderId: holder.id,
						grants,
					})
				}
			/>
		</section>
	);
};

export { AuthSection };
