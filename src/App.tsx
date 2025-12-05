import { useCallback, useEffect, useMemo, useState } from 'react';

import './ui/styles/index.css';

import { t } from '@/i18n';
import type { OverviewResponse } from '@/types/overview';
import { AggregatedSection } from '@/ui/sections/AggregatedSection';
import { BackendsSection } from '@/ui/sections/BackendsSection';
import { DebugPage } from '@/ui/sections/DebugPage';
import { SummarySection } from '@/ui/sections/SummarySection';
import { Button } from '@/ui/shadcn/button';

type LoadState = 'idle' | 'loading' | 'error' | 'ready';

export default function App() {
	const [overview, setOverview] = useState<OverviewResponse | null>(null);
	const [status, setStatus] = useState<LoadState>('idle');
	const [error, setError] = useState<string | null>(null);
	const refresh = useMemo(
		() => async () => {
			setStatus('loading');
			setError(null);
			try {
				const res = await fetch('/ui/overview', { method: 'GET' });
				if (!res.ok) {
					throw new Error(`Request failed with status ${res.status}`);
				}
				const data = (await res.json()) as OverviewResponse;
				setOverview(data);
				setStatus('ready');
			} catch (err) {
				setError((err as Error).message);
				setStatus('error');
			}
		},
		[],
	);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		const eventSource = new EventSource('/ui/events');

		eventSource.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data) as OverviewResponse;
				setOverview(data);
				setStatus('ready');
				setError(null);
			} catch (err) {
				setError((err as Error).message);
			}
		};

		eventSource.onerror = () => {
			setError(t('event.error'));
			setStatus('error');
		};

		return () => {
			eventSource.close();
		};
	}, []);

	const [route, setRoute] = useState<'main' | 'debug'>(() => {
		if (typeof window === 'undefined') return 'main';
		return window.location.pathname.startsWith('/debug') ? 'debug' : 'main';
	});

	useEffect(() => {
		const current = window.location.pathname.startsWith('/debug')
			? 'debug'
			: 'main';
		if (current !== route) {
			setRoute(current);
		}
	}, [route]);

	const navigate = useCallback((target: 'main' | 'debug') => {
		setRoute(target);
		const path = target === 'debug' ? '/debug' : '/';
		window.history.pushState({}, '', path);
	}, []);

	return route === 'debug' ? (
		<DebugPage onNavigate={navigate} />
	) : (
		<div className="container mx-auto max-w-6xl p-6 space-y-6">
			<header className="space-y-2">
				<div className="flex items-center justify-between gap-3">
					<div>
						<h1 className="text-3xl font-bold">{t('app.title')}</h1>
						<p className="text-muted-foreground">{t('app.subtitle')}</p>
					</div>
					<Button
						type="button"
						onClick={() => navigate('debug')}
						className="text-sm"
					>
						{t('debug.title')}
					</Button>
				</div>
			</header>

			<SummarySection
				overview={overview}
				onRefresh={() => void refresh()}
				status={status}
				error={error}
			/>

			<AggregatedSection overview={overview} />

			<BackendsSection
				backends={overview?.backends ?? []}
				onRefresh={() => void refresh()}
			/>
		</div>
	);
}
