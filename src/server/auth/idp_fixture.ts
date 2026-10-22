import { exportJWK, generateKeyPair, SignJWT } from 'jose';

// The signing key of the tests' local OpenID providers.
const KEY_ID = 'test-key';
const { privateKey, publicKey } = await generateKeyPair('RS256');

const jwks = {
	keys: [
		{
			...(await exportJWK(publicKey)),
			kid: KEY_ID,
			alg: 'RS256',
			use: 'sig',
		},
	],
};

// A JWT with these claims, valid for five minutes unless they say otherwise.
const signJwt = (claims: Record<string, unknown>): Promise<string> => {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({
		iat: now,
		exp: now + 300,
		...claims,
	})
		.setProtectedHeader({
			alg: 'RS256',
			kid: KEY_ID,
			typ: 'JWT',
		})
		.sign(privateKey);
};

export { jwks, signJwt };
