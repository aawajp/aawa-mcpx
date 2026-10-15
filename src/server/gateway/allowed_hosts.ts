import { logger } from '@/server/logger';

type Handler = (request: Request) => Response | Promise<Response>;
type Route = Handler | Record<string, Handler>;

const HOST_NOT_ALLOWED = 'Host or Origin is not allowed.';

// MCP 2025-03-26 requires servers to validate Origin against DNS rebinding.
// A rebinding page controls both Origin and Host, so each must name a host
// listed in ALLOWED_HOSTS. A request without Host has no absolute URL and
// fails.
const createHostCheck = (allowedHosts: readonly string[]) => {
	const hosts = new Set(allowedHosts);
	const isAllowed = (url: string): boolean => {
		const hostname = URL.parse(url)?.hostname;
		return hostname !== undefined && hosts.has(hostname);
	};
	return (request: Request): boolean => {
		const origin = request.headers.get('origin');
		if (isAllowed(request.url) && (origin === null || isAllowed(origin)))
			return true;
		logger.warn(
			JSON.stringify({
				message: 'Rejected request for a host that is not allowed',
				host: request.headers.get('host'),
				origin,
			}),
		);
		return false;
	};
};

// Answer every handler of the given routes with `forbidden` when the request
// fails the host check.
const guardRoutes = <T extends Record<string, Route>>(
	routes: T,
	isAllowed: (request: Request) => boolean,
	forbidden: () => Response,
): T => {
	const guard =
		(handler: Handler): Handler =>
		(request) =>
			isAllowed(request) ? handler(request) : forbidden();
	return Object.fromEntries(
		Object.entries(routes).map(([path, route]) => [
			path,
			typeof route === 'function'
				? guard(route)
				: Object.fromEntries(
						Object.entries(route).map(([method, handler]) => [
							method,
							guard(handler),
						]),
					),
		]),
	) as T;
};

export { createHostCheck, guardRoutes, HOST_NOT_ALLOWED };
