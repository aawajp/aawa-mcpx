import type { McpAuth } from '@/server/auth/mcp_auth';
import type { UiAuth } from '@/server/auth/ui_auth';
import { readBody } from '@/server/gateway/http';
import { TESTER_PATH, testerRequestType } from '@/shared/ui_api';

type CreateTesterRoutesParams = {
	mcpRoute: {
		POST: (request: Request) => Promise<Response>;
	};
	// With a login, the Tester's request is signed as the logged-in admin.
	auth?: {
		ui: Pick<UiAuth, 'accessToken' | 'superadminIdOf'>;
		mcp: Pick<McpAuth, 'signTesterRequest'>;
	};
};

const parseBody = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
};

// The dashboard Tester: the browser builds the MCP request, this route signs
// it as the logged-in admin and passes it to the /mcp handler like any client
// request. The answer holds both sides in full, secrets included.
const createTesterRoutes = ({ mcpRoute, auth }: CreateTesterRoutesParams) => {
	// As the superadmin, who has no access token, or with the OIDC admin's.
	const signRequest = async (request: Request, testerRequest: Request) => {
		if (!auth) return;
		const superadminId = auth.ui.superadminIdOf(request);
		if (superadminId !== undefined)
			auth.mcp.signTesterRequest(testerRequest, superadminId);
		else {
			const token = await auth.ui.accessToken(request);
			if (token) testerRequest.headers.set('Authorization', `Bearer ${token}`);
		}
	};
	return {
		[TESTER_PATH]: {
			async POST(request: Request): Promise<Response> {
				const input = await readBody(testerRequestType, request);
				if (input instanceof Response) return input;
				const url = new URL('/mcp', request.url).href;
				const testerRequest = new Request(url, {
					method: 'POST',
					headers: input.headers,
					body: JSON.stringify(input.body),
				});
				await signRequest(request, testerRequest);
				const response = await mcpRoute.POST(testerRequest);
				return Response.json({
					request: {
						method: 'POST',
						url,
						headers: Object.fromEntries(testerRequest.headers),
						body: input.body,
					},
					response: {
						status: response.status,
						headers: Object.fromEntries(response.headers),
						body: parseBody(await response.text()),
					},
				});
			},
		},
	};
};

export { createTesterRoutes };
