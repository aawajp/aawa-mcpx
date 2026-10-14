import { useCallback, useEffect, useState } from 'react';

import { errorMessage } from '@/shared/common';
import { type OverviewResponse, overviewResponseType } from '@/shared/ui_api';
import { postJson } from '@/ui/api/client';
import { t } from '@/ui/i18n';
import { BackendsSection } from '@/ui/sections/BackendsSection';
import { BackendTesterSection } from '@/ui/sections/BackendTesterSection';
import { ClientsSection } from '@/ui/sections/ClientsSection';
import { DebugPage } from '@/ui/sections/DebugPage';
import { SummarySection } from '@/ui/sections/SummarySection';

type MainTab = 'tester' | 'backends' | 'clients';
const MAIN_TABS: MainTab[] = ['backends', 'clients', 'tester'];
const MAIN_TAB_STORAGE_KEY = 'aawa-mcpx-main-tab';
const EVENT_STREAM_RETRY_MS = 5000;
const REFRESH_KEY = 'refresh';
// Server and tool names may contain any character; JSON keeps the key unambiguous.
const pendingKey = (...names: string[]): string => JSON.stringify(names);

const isMainTab = (value: string | null): value is MainTab =>
	MAIN_TABS.some((tab) => tab === value);

const resolveRoute = (): 'main' | 'debug' =>
	window.location.pathname.startsWith('/debug') ? 'debug' : 'main';

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
	const [route, setRoute] = useState(resolveRoute);

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
		void runAction(REFRESH_KEY, '/api/backends/refresh', {
			serverName,
		});
	const isRefreshing = pending.has(REFRESH_KEY);
	const toggleBackend = (params: { serverName: string; enabled: boolean }) =>
		void runAction(
			pendingKey(params.serverName),
			'/api/backends/toggle',
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
		const connect = () => {
			eventSource = new EventSource('/api/events');
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
		const syncRoute = () => setRoute(resolveRoute());
		window.addEventListener('popstate', syncRoute);
		return () => {
			window.removeEventListener('popstate', syncRoute);
		};
	}, []);

	const navigate = useCallback((target: 'main' | 'debug') => {
		setRoute(target);
		const path = target === 'debug' ? '/debug' : '/';
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

	const tabClassName = (tab: MainTab): string => {
		const base =
			'inline-flex items-center rounded-md border px-3 py-2 text-sm font-medium transition';
		if (mainTab === tab) {
			return `${base} border-sky-400/60 bg-sky-500/20 text-sky-100 shadow-sm`;
		}
		return `${base} hover:bg-muted`;
	};

	return (
		<>
			{route === 'debug' ? (
				<DebugPage onNavigate={navigate} />
			) : (
				<div className="app-shell container mx-auto max-w-6xl p-4 space-y-4">
					<header>
						<h1 className="text-3xl font-bold">{t('app.title')}</h1>
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
						{MAIN_TABS.map((tab) => (
							<button
								key={tab}
								type="button"
								onClick={() => selectMainTab(tab)}
								className={tabClassName(tab)}
								aria-pressed={mainTab === tab}
							>
								{t(`main.tab.${tab}`)}
							</button>
						))}
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
							onRefresh={refreshBackends}
							isRefreshing={isRefreshing}
							onToggleBackend={toggleBackend}
							isBackendPending={isBackendPending}
							onToggleTool={(params) =>
								void runAction(
									pendingKey(params.serverName, params.toolName),
									'/api/tools/toggle',
									params,
								)
							}
							isToolPending={(serverName, toolName) =>
								pending.has(pendingKey(serverName, toolName))
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
