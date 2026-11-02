import en from '../i18n/en.json';
import es from '../i18n/es.json';

export type Locale = 'en' | 'es';
export type MessageKey = keyof typeof en;
export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

const CATALOGS: Record<Locale, Record<string, string>> = { en, es };

export function detectLocale(language: string | undefined): Locale {
  return language?.toLowerCase().startsWith('es') ? 'es' : 'en';
}

export function createTranslator(locale: Locale): Translate {
  const catalog = CATALOGS[locale];
  return (key, params = {}) => {
    const template = catalog[key] ?? CATALOGS.en[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match,
    );
  };
}
