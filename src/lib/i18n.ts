import en from '../i18n/en.json';
import es from '../i18n/es.json';

export type Locale = 'en' | 'es';
export type MessageKey = keyof typeof en;
export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

const CATALOGS: Record<Locale, Record<string, string>> = { en, es };

export function detectLocale(language: string | undefined): Locale {
  return language?.toLowerCase().startsWith('es') ? 'es' : 'en';
}

const RULES = new Map<Locale, Intl.PluralRules>();

/**
 * Plural forms (UXA-21: no "action(s)"): with a numeric `count`, `<key>Zero` (when the catalogue has it, so a count of 0
 * is never shown), then `<key>One` (the locale's "one" category, `Intl.PluralRules`), else `<key>` itself (other).
 */
export function pluralKey(catalog: Readonly<Record<string, string>>, fallback: Readonly<Record<string, string>>, locale: Locale, key: string, params: Record<string, string | number> | undefined): string {
  const count = params?.count;
  if (typeof count !== 'number') return key;
  const has = (name: string) => name in catalog || name in fallback;
  if (count === 0 && has(`${key}Zero`)) return `${key}Zero`;
  let rules = RULES.get(locale);
  if (rules === undefined) {
    rules = new Intl.PluralRules(locale);
    RULES.set(locale, rules);
  }
  return rules.select(count) === 'one' && has(`${key}One`) ? `${key}One` : key;
}

/** `{name}` placeholders filled from `params` (unknown ones stay as they are). */
export function fill(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

export function createTranslator(locale: Locale): Translate {
  const catalog = CATALOGS[locale];
  return (key, params = {}) => {
    const name = pluralKey(catalog, CATALOGS.en, locale, key, params);
    return fill(catalog[name] ?? CATALOGS.en[name] ?? key, params);
  };
}
