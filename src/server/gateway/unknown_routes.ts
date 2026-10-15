type WithTrailingSlashes<T> = T & {
	[Path in keyof T as Path extends `${string}/`
		? never
		: `${Path & string}/`]: T[Path];
};

const withTrailingSlashes = <T extends Record<string, unknown>>(
	routes: T,
): WithTrailingSlashes<T> =>
	Object.fromEntries(
		Object.entries(routes).flatMap(([path, route]) =>
			path.endsWith('/')
				? [[path, route]]
				: [
						[path, route],
						[`${path}/`, route],
					],
		),
	) as WithTrailingSlashes<T>;

// Answer requests no route handles: a known path with another method gets 405
// with that path's methods in Allow, any other path 404. Bun answers HEAD from
// GET.
const createUnknownRouteHandler = (routes: Record<string, object>) => {
	const allowedMethods = new Map(
		Object.entries(routes).map(([path, route]) => {
			const methods = Object.keys(route);
			return [
				path,
				(methods.includes('GET') ? [...methods, 'HEAD'] : methods).join(', '),
			];
		}),
	);
	return (request: Request): Response => {
		const { pathname } = new URL(request.url);
		const allow = allowedMethods.get(pathname);
		return allow === undefined
			? Response.json(
					{
						error: `Unknown route: ${pathname}`,
					},
					{
						status: 404,
					},
				)
			: Response.json(
					{
						error: `Method ${request.method} is not allowed on ${pathname}`,
					},
					{
						status: 405,
						headers: {
							Allow: allow,
						},
					},
				);
	};
};

export { createUnknownRouteHandler, withTrailingSlashes };
