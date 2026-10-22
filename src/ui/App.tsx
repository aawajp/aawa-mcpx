import { Activity, useCallback, useEffect, useState } from 'react';

import { errorMessage } from '@/shared/common';
import {
	AUTH_PATHS,
	DASHBOARD_PATHS,
	logoutResponseType,
	type OverviewResponse,
	overviewResponseType,
	UI_PAGE_PATHS,
	uiSessionType,
} from '@/shared/ui_api';
import {
	ApiError,
	currentPage,
	getJson,
	type Page,
	postJson,
} from '@/ui/api/client';
import { Button } from '@/ui/base_components/button';
import { t } from '@/ui/i18n';
import { AuthSection } from '@/ui/sections/auth';
import { BackendsSection } from '@/ui/sections/BackendsSection';
import { ClientsSection } from '@/ui/sections/ClientsSection';
import { DebugPage } from '@/ui/sections/DebugPage';
import { SummarySection } from '@/ui/sections/SummarySection';
import { TesterSection } from '@/ui/sections/TesterSection';

const MAIN_TABS = ['backends', 'clients', 'tester', 'auth'] as const;
type MainTab = (typeof MAIN_TABS)[number];
const MAIN_TAB_STORAGE_KEY = 'aawa-mcpx-main-tab';
const EVENT_STREAM_RETRY_MS = 5000;
const REFRESH_KEY = 'refresh';
// Server and tool names may contain any character; JSON keeps the key unambiguous.
const pendingKey = (...names: string[]): string => JSON.stringify(names);

const isMainTab = (value: string | null): value is MainTab =>
	MAIN_TABS.some((tab) => tab === value);

export default function App() {
	const [overview, setOverview] = useState<OverviewResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [streamError, setStreamError] = useState<string | null>(null);
	const [mainTab, setMainTab] = useState<MainTab>(() => {
		try {
			const stored = window.localStorage.getItem(MAIN_TAB_STORAGE_KEY);
			return isMainTab(stored) ? stored : 'backends';
		} catch {
			return 'backends';
		}
	});
	const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
	const [route, setRoute] = useState<Page>(currentPage);
	const [userName, setUserName] = useState<string | null>(null);

	useEffect(() => {
		void getJson(AUTH_PATHS.session)
			.then((data) => setUserName(uiSessionType.assert(data).name))
			.catch((err) => {
				// Without a login method there is no session endpoint, no login and
				// no Auth tab.
				if (err instanceof ApiError && err.status === 404)
					setMainTab((tab) => (tab === 'auth' ? 'backends' : tab));
				else setError(errorMessage(err));
			});
	}, []);

	const logout = async () => {
		try {
			const { logoutUrl } = logoutResponseType.assert(
				await postJson(AUTH_PATHS.logout, {}),
			);
			window.location.assign(logoutUrl);
		} catch (err) {
			setError(errorMessage(err));
		}
	};

	const runAction = useCallback(
		async (key: string, path: string, body: unknown) => {
			setPending((current) => new Set(current).add(key));
			setError(null);
			try {
				setOverview(overviewResponseType.assert(await postJson(path, body)));
			} catch (err) {
				setError(errorMessage(err));
			} finally {
				setPending((current) => {
					const next = new Set(current);
					next.delete(key);
					return next;
				});
			}
		},
		[],
	);
	const refreshBackends = (serverName?: string) =>
		void runAction(REFRESH_KEY, DASHBOARD_PATHS.refreshBackends, {
			serverName,
		});
	const isRefreshing = pending.has(REFRESH_KEY);
	const toggleBackend = (params: { serverName: string; enabled: boolean }) =>
		void runAction(
			pendingKey(params.serverName),
			DASHBOARD_PATHS.toggleBackend,
			params,
		);
	const isBackendPending = (serverName: string) =>
		pending.has(pendingKey(serverName));

	useEffect(() => {
		if (route !== 'main') {
			return;
		}
		let eventSource: EventSource | undefined;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		// A session check started before cleanup can still reach `connect`.
		let disposed = false;
		const connect = () => {
			if (disposed) return;
			eventSource = new EventSource(DASHBOARD_PATHS.events);
			eventSource.onmessage = (event) => {
				try {
					const payload = JSON.parse(event.data) as unknown;
					const data = overviewResponseType.assert(payload);
					setOverview(data);
					setStreamError(null);
				} catch (err) {
					setStreamError(errorMessage(err));
				}
			};
			eventSource.onerror = () => {
				setStreamError(t('event.error'));
				if (eventSource?.readyState === EventSource.CLOSED) {
					// A closed stream may mean the session ended; the session check
					// then sends the browser to the login.
					retryTimer = setTimeout(
						() =>
							void getJson(AUTH_PATHS.session)
								.catch(() => undefined)
								.finally(connect),
						EVENT_STREAM_RETRY_MS,
					);
				}
			};
		};
		connect();

		return () => {
			disposed = true;
			clearTimeout(retryTimer);
			eventSource?.close();
		};
	}, [route]);

	useEffect(() => {
		const syncRoute = () => setRoute(currentPage());
		window.addEventListener('popstate', syncRoute);
		return () => {
			window.removeEventListener('popstate', syncRoute);
		};
	}, []);

	const navigate = useCallback((target: 'main' | 'debug') => {
		setRoute(target);
		const path = UI_PAGE_PATHS[target];
		if (window.location.pathname !== path) {
			window.history.pushState({}, '', path);
		}
	}, []);

	const selectMainTab = useCallback((tab: MainTab) => {
		setMainTab(tab);
		try {
			window.localStorage.setItem(MAIN_TAB_STORAGE_KEY, tab);
		} catch {}
	}, []);

	// The signed-in user, on the line of each page's title.
	const session =
		userName === null ? null : (
			<div className="flex items-center gap-3">
				<span className="text-muted-foreground">{userName}</span>
				<Button type="button" onClick={() => void logout()}>
					{t('session.logout')}
				</Button>
			</div>
		);

	return (
		<>
			{route === 'debug' ? (
				<DebugPage onNavigate={navigate} session={session} />
			) : null}
			{/* Hidden instead of unmounted, so the Tester keeps its runs across pages. */}
			<Activity mode={route === 'debug' ? 'hidden' : 'visible'}>
				<div className="app-shell container mx-auto max-w-6xl p-4 space-y-4">
					<header className="flex items-center justify-between gap-3">
						<h1 className="text-3xl font-bold">{t('app.title')}</h1>
						{session}
					</header>

					<SummarySection
						overview={overview}
						onRefresh={refreshBackends}
						onShowBackends={() => selectMainTab('backends')}
						onToggleBackend={toggleBackend}
						isBackendPending={isBackendPending}
						isRefreshing={isRefreshing}
						error={error ?? streamError}
					/>
					<div className="flex items-center gap-2">
						{/* The Auth tab exists only with a login method, which gives a login. */}
						{MAIN_TABS.filter((tab) => tab !== 'auth' || userName !== null).map(
							(tab) => (
								<Button
									key={tab}
									type="button"
									onClick={() => selectMainTab(tab)}
									className={
										mainTab === tab
											? 'border-sky-400/60 bg-sky-500/20 text-sky-100 shadow-sm'
											: ''
									}
									aria-pressed={mainTab === tab}
								>
									{t(`main.tab.${tab}`)}
								</Button>
							),
						)}
						<Button type="button" onClick={() => navigate('debug')}>
							{t('debug.title')}
						</Button>
					</div>

					{mainTab === 'auth' && userName !== null ? (
						<AuthSection backends={overview?.backends ?? []} />
					) : null}
					<Activity mode={mainTab === 'tester' ? 'visible' : 'hidden'}>
						<TesterSection backends={overview?.backends ?? []} />
					</Activity>
					{mainTab === 'clients' ? (
						<ClientsSection clients={overview?.clients ?? []} />
					) : null}
					{mainTab === 'backends' ? (
						<BackendsSection
							backends={overview?.backends ?? []}
							onRefresh={refreshBackends}
							isRefreshing={isRefreshing}
							onToggleBackend={toggleBackend}
							isBackendPending={isBackendPending}
							onToggleTool={(params) =>
								void runAction(
									pendingKey(params.serverName, params.toolName),
									DASHBOARD_PATHS.toggleTool,
									params,
								)
							}
							isToolPending={(serverName, toolName) =>
								pending.has(pendingKey(serverName, toolName))
							}
						/>
					) : null}
				</div>
			</Activity>
			<footer className="container mx-auto max-w-6xl px-6 pb-6 pt-2 text-center text-muted-foreground">
				<p>
					© {new Date().getFullYear()}{' '}
					<a href="https://aawa.jp">Aawa Technologies</a> / Mikael Nakajima
				</p>
			</footer>
		</>
	);
}
