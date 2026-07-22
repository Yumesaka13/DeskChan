import { type ParentProps, createSignal, createEffect } from 'solid-js';
import { I18nProvider } from './i18n';
import { ThemeProvider } from './lib/theme';
import Desktop from './components/Desktop';

/**
 * Root application component.
 * Wraps the app with i18n and theme providers, then renders the Desktop.
 */
export default function App() {
    return (
        <I18nProvider>
            <ThemeProvider>
                <Desktop />
            </ThemeProvider>
        </I18nProvider>
    );
}
