import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// The dashboard's bordered button; a link that acts as one takes this class.
const BUTTON_CLASS =
	'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md border px-3 py-0.5 leading-tight font-medium transition hover:bg-muted disabled:opacity-50';

// A bordered form field that fills its container.
const INPUT_CLASS =
	'w-full rounded-md border bg-background px-2 py-0.5 outline-none focus:bg-muted/40';

const CHECKBOX_CLASS =
	'h-4 w-4 shrink-0 rounded border border-sky-400/50 bg-slate-950 align-middle';

const cn = (...inputs: ClassValue[]) => {
	return twMerge(clsx(inputs));
};

export { BUTTON_CLASS, CHECKBOX_CLASS, cn, INPUT_CLASS };
