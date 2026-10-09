// Stop waiting without cancelling shared work (such as a catalog refresh).
// The original promise stays observed, so late completion/rejection is harmless.
const withCancellation = async <T>(
	work: Promise<T>,
	signal?: AbortSignal,
): Promise<T> => {
	if (!signal) return work;
	let abort: () => void = () => undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				abort = () => reject(signal.reason);
				if (signal.aborted) abort();
				else
					signal.addEventListener('abort', abort, {
						once: true,
					});
			}),
		]);
	} finally {
		signal.removeEventListener('abort', abort);
	}
};

export { withCancellation };
