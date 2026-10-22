import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from '@/ui/App';
import { currentPage } from '@/ui/api/client';
import { LoginPage } from '@/ui/sections/LoginPage';

const elem = document.getElementById('root');
const app = (
	<StrictMode>{currentPage() === 'login' ? <LoginPage /> : <App />}</StrictMode>
);

if (import.meta.hot) {
	if (!import.meta.hot.data.root && elem) {
		import.meta.hot.data.root = createRoot(elem);
	}

	import.meta.hot.data.root.render(app);
} else if (elem) {
	createRoot(elem).render(app);
}
