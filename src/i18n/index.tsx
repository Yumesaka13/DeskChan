import {
    createContext,
    useContext,
    createSignal,
    type ParentProps,
    type Accessor,
} from 'solid-js';
import { type Translations, zhCN } from './zh-CN';
import { enUS } from './en-US';

type Locale = 'zh-CN' | 'en-US';

const locales: Record<Locale, Translations> = {
    'zh-CN': zhCN,
    'en-US': enUS,
};

interface I18nContextValue {
    locale: Accessor<Locale>;
    setLocale: (l: Locale) => void;
    t: (key: keyof Translations) => string;
}

const I18nContext = createContext<I18nContextValue>();

/**
 * Provides i18n context to all descendants.
 * Usage: wrap your app root with <I18nProvider>.
 */
export function I18nProvider(props: ParentProps) {
    // Detect browser language preference
    const browserLang = typeof navigator !== 'undefined'
        ? navigator.language.startsWith('zh') ? 'zh-CN' : 'en-US'
        : 'en-US';

    const [locale, setLocale] = createSignal<Locale>(browserLang as Locale);

    const t = (key: keyof Translations): string => {
        const dict = locales[locale()];
        return (dict[key] as string) ?? locales['en-US'][key] ?? String(key);
    };

    const value: I18nContextValue = { locale, setLocale, t };

    return (
        <I18nContext.Provider value={value}>
            {props.children}
        </I18nContext.Provider>
    );
}

/**
 * Hook to access i18n within a SolidJS component.
 * Must be called inside <I18nProvider>.
 */
export function useI18n(): I18nContextValue {
    const ctx = useContext(I18nContext);
    if (!ctx) throw new Error('useI18n must be used within I18nProvider');
    return ctx;
}

export type { Translations, Locale };
