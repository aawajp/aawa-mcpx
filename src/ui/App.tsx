import { useCallback, useEffect, useMemo, useState } from 'react';

import '@/ui/styles/index.css';

import { t } from '@/ui/i18n';
import { type OverviewResponse, overviewResponseType } from '@/shared/ui_api';
import { BackendsSection } from '@/ui/sections/BackendsSection';
import { BackendTesterSection } from '@/ui/sections/BackendTesterSection';
import { ClientsSection } from '@/ui/sections/ClientsSection';
import { DebugPage } from '@/ui/sections/DebugPage';
import { SummarySection } from '@/ui/sections/SummarySection';
import { errorMessage } from '@/shared/common';

type LoadState = 'idle' | 'loading' | 'error' | 'ready';
type MainTab = 'tester' | 'backends' | 'clients';
const MAIN_TAB_STORAGE_KEY = 'aawa-mcpx-main-tab';

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
	const [error, setError] = useState<string | null>(null);
	const [mainTab, setMainTab] = useState<MainTab>(() => {
		if (typeof window === 'undefined') return 'backends';
		const stored = window.localStorage.getItem(MAIN_TAB_STORAGE_KEY);
		return isMainTab(stored) ? stored : 'backends';
	});
	const [pendingBackends, setPendingBackends] = useState<Record<string, boolean>>(
		{},
	);
	const [pendingTools, setPendingTools] = useState<Record<string, boolean>>({});
	const [route, setRoute] = useState<'main' | 'debug'>(() => {
		if (typeof window === 'undefined') return 'main';
		return resolveRoute();
	});

	const refresh = useCallback(async () => {
		setStatus('loading');
		setError(null);
		try {
			const res = await fetch('/api/overview', { method: 'GET' });
			if (!res.ok) {
				throw new Error(`Request failed with status ${res.status}`);
			}
			const data = overviewResponseType.assert(await res.json());
			setOverview(data);
			setStatus('ready');
		} catch (err) {
			setError(errorMessage(err));
			setStatus('error');
		}
	}, []);

	const toggleBackend = useCallback(
		async (params: { serverName: string; enabled: boolean }) => {
			setPendingBackends((current) => ({
				...current,
				[params.serverName]: true,
			}));
			try {
				const response = await fetch('/api/backends/toggle', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(params),
				});
				if (!response.ok) {
					throw new Error(`Failed to update backend state (${response.status})`);
				}
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
		async (params: { name: string; enabled: boolean }) => {
			setPendingTools((current) => ({
				...current,
				[params.name]: true,
			}));
			try {
				const response = await fetch('/api/tools/toggle', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(params),
				});
				if (!response.ok) {
					throw new Error(`Failed to update tool state (${response.status})`);
				}
				setOverview((current) => {
					if (!current) {
						return current;
					}
					return {
						...current,
						aggregated: {
							...current.aggregated,
							tools: current.aggregated.tools.map((tool) => {
								if (tool.name !== params.name) {
									return tool;
								}
								return {
									...tool,
									enabled: params.enabled,
								};
							}),
						},
					};
				});
			} catch (err) {
				setError(errorMessage(err));
			} finally {
				setPendingTools((current) => ({
					...current,
					[params.name]: false,
				}));
			}
		},
		[],
	);

	const enabledToolMap = useMemo(() => {
		const map = new Map<string, boolean>();
		if (!overview) {
			return map;
		}
		for (const tool of overview.aggregated.tools) {
			map.set(tool.name, tool.enabled);
		}
		return map;
	}, [overview]);

	useEffect(() => {
		if (route !== 'main') {
			return;
		}
		const eventSource = new EventSource('/api/events');

		eventSource.onmessage = (event) => {
			try {
				const payload = JSON.parse(event.data) as unknown;
				const data = overviewResponseType.assert(payload);
				setOverview(data);
				setStatus('ready');
				setError(null);
			} catch (err) {
				setError(errorMessage(err));
			}
		};

		eventSource.onerror = () => {
			setError(t('event.error'));
			setStatus('error');
		};

		return () => {
			eventSource.close();
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
				onRefresh={() => void refresh()}
				onToggleBackend={(params) => void toggleBackend(params)}
				isBackendPending={(serverName) =>
					pendingBackends[serverName] === true
				}
				status={status}
				error={error}
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
					onRefresh={() => void refresh()}
					onToggleTool={(params) => void toggleTool(params)}
					isToolEnabled={(name) => enabledToolMap.get(name) === true}
					isToolPending={(name) => pendingTools[name] === true}
				/>
			) : null}
				</div>
			)}
			<footer className="container mx-auto max-w-6xl px-6 pb-6 pt-2 text-center text-sm text-muted-foreground">
				<p>
					© {new Date().getFullYear()}{' '}
					<a href="https://aawa.jp">Aawa Technologies</a> / Mikael
					Nakajima
				</p>
			</footer>
		</>
	);
}
