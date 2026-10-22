import { useEffect, useState } from 'react';

import { errorMessage } from '@/shared/common';
import {
	AUTH_PATHS,
	loginMethodsType,
	passwordLoginResponseType,
	RETURN_TO_PARAM,
	UI_PAGE_PATHS,
} from '@/shared/ui_api';
import { ApiError, getJson, postJson } from '@/ui/api/client';
import { Button } from '@/ui/base_components/button';
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from '@/ui/base_components/card';
import { BUTTON_CLASS, INPUT_CLASS } from '@/ui/base_components/classes';
import { t } from '@/ui/i18n';

type LoginMethods = typeof loginMethodsType.infer;

// The dashboard login: the superadmin's username and password, OIDC, or both,
// as the gateway's settings turn them on.
const LoginPage = () => {
	const [methods, setMethods] = useState<LoginMethods | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [username, setUsername] = useState('');
	const [password, setPassword] = useState('');
	const [busy, setBusy] = useState(false);
	const returnTo =
		new URLSearchParams(window.location.search).get(RETURN_TO_PARAM) ??
		UI_PAGE_PATHS.main;

	useEffect(() => {
		void getJson(AUTH_PATHS.methods)
			.then((data) => {
				const found = loginMethodsType.assert(data);
				// The session cookie belongs to PUBLIC_URL's host.
				if (window.location.origin !== found.publicUrl)
					window.location.assign(
						new URL(
							window.location.pathname + window.location.search,
							found.publicUrl,
						).href,
					);
				else setMethods(found);
			})
			.catch((err) => {
				// Without a login method, the dashboard needs no login.
				if (err instanceof ApiError && err.status === 404)
					window.location.assign(UI_PAGE_PATHS.main);
				else setError(errorMessage(err));
			});
	}, []);

	const logIn = async () => {
		setBusy(true);
		setError(null);
		try {
			const answer = passwordLoginResponseType.assert(
				await postJson(AUTH_PATHS.password, {
					username,
					password,
					returnTo,
				}),
			);
			window.location.assign(answer.returnTo);
		} catch (err) {
			setError(errorMessage(err));
			setBusy(false);
		}
	};

	return (
		<div className="container mx-auto max-w-sm space-y-4 p-4">
			<h1 className="text-3xl font-bold">{t('app.title')}</h1>
			<Card>
				<CardHeader>
					<CardTitle>{t('login.title')}</CardTitle>
				</CardHeader>
				<CardContent className="space-y-3">
					{error ? <p className="text-rose-300">{error}</p> : null}
					{methods?.password ? (
						<form
							className="space-y-2"
							onSubmit={(event) => {
								event.preventDefault();
								void logIn();
							}}
						>
							<input
								value={username}
								placeholder={t('login.username')}
								aria-label={t('login.username')}
								autoComplete="username"
								onChange={(event) => setUsername(event.target.value)}
								className={INPUT_CLASS}
							/>
							<input
								type="password"
								value={password}
								placeholder={t('login.password')}
								aria-label={t('login.password')}
								autoComplete="current-password"
								onChange={(event) => setPassword(event.target.value)}
								className={INPUT_CLASS}
							/>
							<Button
								type="submit"
								disabled={busy || !username || !password}
								className="w-full"
							>
								{t('login.submit')}
							</Button>
						</form>
					) : null}
					{methods?.oidc ? (
						<a
							href={`${AUTH_PATHS.login}?${new URLSearchParams({
								[RETURN_TO_PARAM]: returnTo,
							})}`}
							className={`${BUTTON_CLASS} w-full`}
						>
							{t('login.oidc')}
						</a>
					) : null}
				</CardContent>
			</Card>
		</div>
	);
};

export { LoginPage };
