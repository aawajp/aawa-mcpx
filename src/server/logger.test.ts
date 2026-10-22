import { escapeControls, logFields } from '@/server/logger';

import { expect, test } from 'bun:test';

test('log fields are snake_case key=value pairs, quoted when needed', () => {
	expect(
		logFields({
			op: 'save_role',
			admin_id: undefined,
			created: true,
			count: 2,
			roles: ['ops', 'on call'],
			role_name: 'a "b"',
		}),
	).toBe(
		'op=save_role admin_id=none created=true count=2 roles=[ops,"on call"] role_name="a \\"b\\""',
	);
});

test('control characters are escaped, so every log record is one line', () => {
	expect(escapeControls('client=a\nfake [error] line\r\t\u0000\u009b')).toBe(
		'client=a\\nfake [error] line\\r\\t\\u0000\\u009b',
	);
	expect(escapeControls('plain ä 🙂')).toBe('plain ä 🙂');
});
