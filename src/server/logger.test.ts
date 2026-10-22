import { escapeControls } from '@/server/logger';

import { expect, test } from 'bun:test';

test('control characters are escaped, so every log record is one line', () => {
	expect(escapeControls('client=a\nfake [error] line\r\t\u0000\u009b')).toBe(
		'client=a\\nfake [error] line\\r\\t\\u0000\\u009b',
	);
	expect(escapeControls('plain ä 🙂')).toBe('plain ä 🙂');
});
