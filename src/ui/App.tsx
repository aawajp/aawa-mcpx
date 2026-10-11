import { useCallback, useEffect, useState } from 'react';

import { errorMessage } from '@/shared/common';
import {
	type OverviewResponse,
	overviewResponseType,
	toggleToolResponseType,
} from '@/shared/ui_api';
import { fetchJson } from '@/ui/api/client';
import { t } from '@/ui/i18n';
import { BackendsSection } from '@/ui/sections/BackendsSection';
import { BackendTesterSection } from '@/ui/sections/BackendTesterSection';
import { ClientsSection } from '@/ui/sections/ClientsSection';
import { DebugPage } from '@/ui/sections/DebugPage';
import { SummarySection } from '@/ui/sections/SummarySection';

type LoadState = 'idle' | 'loading' | 'error' | 'ready';
type MainTab = 'tester' | 'backends' | 'clients';
const MAIN_TAB_STORAGE_KEY = 'aawa-mcpx-main-tab';
const EVENT_STREAM_RETRY_MS = 5000;
// Server and tool names may contain any character; JSON keeps the pair unambiguous.
const toolKey = (serverName: string, toolName: string): string =>
	JSON.stringify([serverName, toolName]);

const isMainTab = (value: string | null): value is MainTab => {
	return value === 'backends' || value === 'clients' || value === 'tester';
};

export default function App() {
	const resolveRoute = useCallback((): 'main' | 'debug' => {
		if (window.location.pathname.startsWith('/debug')) {
			return 'debug';
		}
		return 'main';
	}, []);

	const [overview, setOverview] = useState<OverviewResponse | null>(null);
	const [status, setStatus] = useState<LoadState>('idle');
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [streamError, setStreamError] = useState<string | null>(null);
	const [mainTab, setMainTab] = useState<MainTab>(() => {
		if (typeof window === 'undefined') return 'backends';
		const stored = window.localStorage.getItem(MAIN_TAB_STORAGE_KEY);
		return isMainTab(stored) ? stored : 'backends';
	});
	const [pendingBackends, setPendingBackends] = useState<
		Record<string, boolean>
	>({});
	const [pendingTools, setPendingTools] = useState<Record<string, boolean>>({});
	const [route, setRoute] = useState<'main' | 'debug'>(() => {
		if (typeof window === 'undefined') return 'main';
		return resolveRoute();
	});

	const refresh = useCallback(
		async (options?: { force?: boolean; serverName?: string }) => {
			setStatus('loading');
			setError(null);
			// SSE snapshots may arrive during the fetch; keep buttons busy until
			// the explicit backend refresh finishes.
			if (options?.force) setIsRefreshing(true);
			try {
				const data = options?.force
					? await fetchJson('/api/backends/refresh', {
							method: 'POST',
							headers: {
								'Content-Type': 'application/json',
							},
							body: JSON.stringify({
								serverName: options.serverName,
							}),
						})
					: await fetchJson('/api/overview', {
							method: 'GET',
						});
				setOverview(overviewResponseType.assert(data));
				setStatus('ready');
			} catch (err) {
				setError(errorMessage(err));
				setStatus('error');
			} finally {
				if (options?.force) setIsRefreshing(false);
			}
		},
		[],
	);

	const toggleBackend = useCallback(
		async (params: { serverName: string; enabled: boolean }) => {
			setPendingBackends((current) => ({
				...current,
				[params.serverName]: true,
			}));
			setError(null);
			try {
				await fetchJson('/api/backends/toggle', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify(params),
				});
				await refresh();
			} catch (err) {
				setError(errorMessage(err));
				setStatus('error');
			} finally {
				setPendingBackends((current) => ({
					...current,
					[params.serverName]: false,
				}));
			}
		},
		[refresh],
	);

	useEffect(() => {
		if (route !== 'main') {
			return;
		}
		void refresh();
	}, [refresh, route]);

	const toggleTool = useCallback(
		async (params: {
			serverName: string;
			toolName: string;
			enabled: boolean;
		}) => {
			const key = toolKey(params.serverName, params.toolName);
			setPendingTools((current) => ({
				...current,
				[key]: true,
			}));
			setError(null);
			try {
				const { enabledTools } = toggleToolResponseType.assert(
					await fetchJson('/api/tools/toggle', {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
						},
						body: JSON.stringify(params),
					}),
				);
				setOverview((current) => {
					if (!current) {
						return current;
					}
					return {
						...current,
						backends: current.backends.map((backend) =>
							backend.serverName === params.serverName
								? {
										...backend,
										enabledTools,
									}
								: backend,
						),
					};
				});
			} catch (err) {
				setError(errorMessage(err));
			} finally {
				setPendingTools((current) => ({
					...current,
					[key]: false,
				}));
			}
		},
		[],
	);

	useEffect(() => {
		if (route !== 'main') {
			return;
		}
		let eventSource: EventSource | undefined;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		const connect = () => {
			eventSource = new EventSource('/api/events');
			eventSource.onmessage = (event) => {
				try {
					const payload = JSON.parse(event.data) as unknown;
					const data = overviewResponseType.assert(payload);
					setOverview(data);
					setStatus('ready');
					setStreamError(null);
				} catch (err) {
					setStreamError(errorMessage(err));
				}
			};
			eventSource.onerror = () => {
				setStreamError(t('event.error'));
				if (eventSource?.readyState === EventSource.CLOSED) {
					retryTimer = setTimeout(connect, EVENT_STREAM_RETRY_MS);
				}
			};
		};
		connect();

		return () => {
			clearTimeout(retryTimer);
			eventSource?.close();
		};
	}, [route]);

	useEffect(() => {
		const syncRoute = () => {
			const current = resolveRoute();
			setRoute((currentRoute) => {
				if (currentRoute === current) {
					return currentRoute;
				}
				return current;
			});
		};

		syncRoute();
		window.addEventListener('popstate', syncRoute);
		return () => {
			window.removeEventListener('popstate', syncRoute);
		};
	}, [resolveRoute]);

	const navigate = useCallback((target: 'main' | 'debug') => {
		setRoute(target);
		const path = target === 'debug' ? '/debug' : '/';
		if (window.location.pathname !== path) {
			window.history.pushState({}, '', path);
		}
	}, []);

	const selectMainTab = useCallback((tab: MainTab) => {
		setMainTab(tab);
		window.localStorage.setItem(MAIN_TAB_STORAGE_KEY, tab);
	}, []);

	const tabClassName = useCallback(
		(tab: MainTab): string => {
			const base =
				'inline-flex items-center rounded-md border px-3 py-2 text-sm font-medium transition';
			if (mainTab === tab) {
				return `${base} border-sky-400/60 bg-sky-500/20 text-sky-100 shadow-sm`;
			}
			return `${base} hover:bg-muted`;
		},
		[mainTab],
	);

	return (
		<>
			{route === 'debug' ? (
				<DebugPage onNavigate={navigate} />
			) : (
				<div className="app-shell container mx-auto max-w-6xl p-6 space-y-6">
					<header className="space-y-2">
						<div>
							<h1 className="text-3xl font-bold">{t('app.title')}</h1>
							<p className="text-muted-foreground">{t('app.subtitle')}</p>
						</div>
					</header>

					<SummarySection
						overview={overview}
						onRefresh={() =>
							void refresh({
								force: true,
							})
						}
						onToggleBackend={(params) => void toggleBackend(params)}
						isBackendPending={(serverName) =>
							pendingBackends[serverName] === true
						}
						status={status}
						isRefreshing={isRefreshing}
						error={error ?? streamError}
					/>
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={() => selectMainTab('backends')}
							className={tabClassName('backends')}
							aria-pressed={mainTab === 'backends'}
						>
							{t('main.tab.backends')}
						</button>
						<button
							type="button"
							onClick={() => selectMainTab('clients')}
							className={tabClassName('clients')}
							aria-pressed={mainTab === 'clients'}
						>
							{t('main.tab.clients')}
						</button>
						<button
							type="button"
							onClick={() => selectMainTab('tester')}
							className={tabClassName('tester')}
							aria-pressed={mainTab === 'tester'}
						>
							{t('main.tab.tester')}
						</button>
						<button
							type="button"
							onClick={() => navigate('debug')}
							className="inline-flex items-center rounded-md border px-3 py-2 text-sm font-medium transition hover:bg-muted"
						>
							{t('debug.title')}
						</button>
					</div>

					{mainTab === 'tester' ? (
						<BackendTesterSection backends={overview?.backends ?? []} />
					) : null}
					{mainTab === 'clients' ? (
						<ClientsSection clients={overview?.clients ?? []} />
					) : null}
					{mainTab === 'backends' ? (
						<BackendsSection
							backends={overview?.backends ?? []}
							onRefresh={(serverName) =>
								void refresh({
									force: true,
									serverName,
								})
							}
							isRefreshing={isRefreshing}
							onToggleTool={(params) => void toggleTool(params)}
							isToolPending={(serverName, toolName) =>
								pendingTools[toolKey(serverName, toolName)] === true
							}
						/>
					) : null}
				</div>
			)}
			<footer className="container mx-auto max-w-6xl px-6 pb-6 pt-2 text-center text-sm text-muted-foreground">
				<p>
					© {new Date().getFullYear()}{' '}
					<a href="https://aawa.jp">Aawa Technologies</a> / Mikael Nakajima
				</p>
			</footer>
		</>
	);
}
