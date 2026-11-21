import { I18nProvider } from './i18n';
import { ThemeProvider } from './lib/theme';
import Desktop from './features/desktop/Desktop';
import { NativeBackdropProvider } from './platform/NativeBackdrops';

/**
 * Root application component.
 * Wraps the app with i18n and theme providers, then renders the Desktop.
 */
export default function App() {
    return (
        <I18nProvider>
            <ThemeProvider>
                <NativeBackdropProvider>
                    <Desktop />
                </NativeBackdropProvider>
            </ThemeProvider>
        </I18nProvider>
    );
}
