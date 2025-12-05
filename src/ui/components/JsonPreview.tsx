const JsonPreview = ({ data }: { data: unknown }) => (
	<pre className="rounded bg-muted px-3 py-2 text-left text-xs overflow-auto max-h-60 max-w-full whitespace-pre-wrap break-words">
		{JSON.stringify(data, null, 2)}
	</pre>
);

export { JsonPreview };
