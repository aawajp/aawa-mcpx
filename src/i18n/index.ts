import stringsJson from '@/i18n/strings.json' with { type: 'json' };

type Strings = typeof stringsJson;
type StringKey = keyof Strings;

const t = (key: StringKey): string => stringsJson[key];

export type { StringKey, Strings };
export { t };
