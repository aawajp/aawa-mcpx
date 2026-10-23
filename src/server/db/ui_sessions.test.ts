import { openMainDatabase } from '@/server/db/main';
import { createUiSessionStore } from '@/server/db/ui_sessions';

import { expect, it } from 'bun:test';

it('sessions are stored by ID hash and can be touched and deleted', () => {
	const db = openMainDatabase(':memory:');
	const store = createUiSessionStore(db);
	const claims = {
		sub: 'user-1',
		roles: ['admin'],
	};
	const { sessionId, session } = store.create({
		issuer: 'https://idp.example',
		clientId: 'client',
		claims,
		createdAt: 1000,
	});
	expect(sessionId).toMatch(/^[\w-]{43}$/);
	expect(session.idHash).not.toContain(sessionId);
	expect(db.query('SELECT id_hash FROM ui_sessions').all()).toEqual([
		{
			id_hash: session.idHash,
		},
	]);
	expect(store.find(sessionId)).toEqual({
		idHash: session.idHash,
		issuer: 'https://idp.example',
		clientId: 'client',
		claims,
		createdAt: 1000,
		lastUsedAt: 1000,
	});
	expect(store.find(session.idHash)).toBeUndefined();
	store.touch(session.idHash, 5000);
	expect(store.find(sessionId)?.lastUsedAt).toBe(5000);
	expect(store.list()).toHaveLength(1);
	store.delete(session.idHash);
	expect(store.find(sessionId)).toBeUndefined();
	expect(store.list()).toEqual([]);
	db.close();
});

it("deleting a user's sessions keeps the other users' sessions", () => {
	const db = openMainDatabase(':memory:');
	const store = createUiSessionStore(db);
	const create = (sub: string) =>
		store.create({
			issuer: 'https://idp.example',
			clientId: 'client',
			claims: {
				sub,
			},
			createdAt: 1000,
		}).sessionId;
	const first = create('user-1');
	const second = create('user-1');
	const other = create('user-2');
	expect(store.deleteForUser('user-1')).toBe(2);
	expect(store.find(first)).toBeUndefined();
	expect(store.find(second)).toBeUndefined();
	expect(store.find(other)).toBeDefined();
	expect(store.deleteForUser('user-1')).toBe(0);
	db.close();
});
