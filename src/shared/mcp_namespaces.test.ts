import {
	addPrefix,
	addResourcePrefix,
	addResourceTemplatePrefix,
	parsePrefix,
	parseResourceUri,
} from '@/shared/mcp_namespaces';

import { expect, test } from 'bun:test';

test('namespaces round-trip backend keys without separator or escape collisions', () => {
	const names = [
		'a',
		'.',
		'..',
		'a_',
		'a__b',
		'a___',
		'a/b',
		'A.b-1',
		'team name',
		'日本語',
		'',
		'\ud800',
		'mcpx-',
		'mcpx-0061005f',
	];
	const publicNames = new Set<string>();
	for (const serverName of names)
		for (const name of [
			'b',
			'_b',
			'b__c',
			'___b',
		]) {
			const prefixed = addPrefix({
				serverName,
				name,
			});
			expect(publicNames.has(prefixed)).toBe(false);
			publicNames.add(prefixed);
			expect(parsePrefix(prefixed)).toEqual({
				serverName,
				originalName: name,
			});
		}
	expect(
		addPrefix({
			serverName: 'ordinary',
			name: 'tool__one',
		}),
	).toBe('ordinary__tool__one');
});

test('malformed and noncanonical namespaces are rejected', () => {
	for (const name of [
		'',
		'tool',
		'__tool',
		'backend__',
		'a b__tool',
		'mcpx-bad__tool',
		'mcpx-0061__tool',
	])
		expect(() => parsePrefix(name)).toThrow();
});

test('resource wrappers preserve complete original URIs and distinguish backends', () => {
	for (const serverName of [
		'Backend',
		'.',
		'..',
		'a__b',
		'1 digit',
		'日本語',
		'a://b',
		'',
	]) {
		for (const uri of [
			'file:///a%2fb',
			'HTTPS://Example.COM/a/../b?q=https://other/#section',
			'urn:example:one',
			'data:text/plain,a%20b',
			'custom://host/path?x=1&y=2',
			'file:///a%23b',
		]) {
			const wrapped = addResourcePrefix({
				serverName,
				uri,
			});
			expect(URL.canParse(wrapped)).toBe(true);
			expect(new URL(wrapped).href).toBe(wrapped);
			expect(parseResourceUri(wrapped)).toEqual({
				serverName,
				originalUri: uri,
			});
		}
	}
	expect(
		addResourcePrefix({
			serverName: 'a',
			uri: 'file:///a',
		}),
	).not.toBe(
		addResourcePrefix({
			serverName: 'a__b',
			uri: 'file:///a',
		}),
	);
	expect(parseResourceUri('legacy://file:///a%2fb?q=1#fragment')).toEqual({
		serverName: 'legacy',
		originalUri: 'file:///a%2fb?q=1#fragment',
	});
});

test('resource requests reject malformed wrappers and decoded URI syntax', () => {
	for (const uri of [
		'file:///a',
		'backend://relative',
		'backend://file:///bad space',
		'backend://file:///bad%ZZ',
		'aawa-mcpx://resource/unknown',
		'aawa-mcpx://resource/backend/%ZZ',
		'aawa-mcpx://resource/backend/file%3a%2f%2f%2fa',
		'aawa-mcpx://resource/backend/file%3A%2F%2F%2Fa#injected',
		'aawa-mcpx://resource/mcpx-0061/file%3A%2F%2F%2Fa',
		'aawa-mcpx://bad/file:///a',
	])
		expect(() => parseResourceUri(uri)).toThrow();
});

test('template wrappers keep the backend template so client expansions route intact', () => {
	for (const serverName of [
		'Backend',
		'a__b',
		'日本語',
	]) {
		const wrapped = addResourceTemplatePrefix({
			serverName,
			uriTemplate: 'file:///logs/{name}{?lines}',
		});
		expect(wrapped.endsWith('/file:///logs/{name}{?lines}')).toBe(true);
		// A client expands name="a b/c" and lines=5 as the backend itself would.
		const expanded = wrapped.replace('{name}{?lines}', 'a%20b%2Fc?lines=5');
		expect(URL.canParse(expanded)).toBe(true);
		expect(parseResourceUri(expanded)).toEqual({
			serverName,
			originalUri: 'file:///logs/a%20b%2Fc?lines=5',
		});
	}
	for (const uri of [
		'aawa-mcpx://template/backend',
		'aawa-mcpx://template//file:///a',
		'aawa-mcpx://template/backend/file:///{name}',
		'aawa-mcpx://template/backend/file:///a b',
	])
		expect(() => parseResourceUri(uri)).toThrow();
});
