import {
    createContext,
    useContext,
    createSignal,
    createEffect,
    onCleanup,
    type ParentProps,
    type Accessor,
} from 'solid-js';

type Theme = 'light' | 'dark' | 'auto';

interface ThemeContextValue {
    theme: Accessor<Theme>;
    setTheme: (t: Theme) => void;
    resolvedTheme: Accessor<'light' | 'dark'>;
}

const ThemeContext = createContext<ThemeContextValue>();

/**
 * Provides theme context and applies the appropriate class to <html>.
 */
export function ThemeProvider(props: ParentProps) {
    const saved = (typeof localStorage !== 'undefined'
        ? (localStorage.getItem('deskchan-theme') as Theme | null)
        : null) ?? 'auto';

    const [theme, setTheme] = createSignal<Theme>(saved);
    const [resolvedTheme, setResolvedTheme] = createSignal<'light' | 'dark'>('light');

    // Apply theme class to <html>
    createEffect(() => {
        const t = theme();
        const apply = (resolved: 'light' | 'dark') => {
            setResolvedTheme(resolved);
            document.documentElement.classList.toggle('dark', resolved === 'dark');
            localStorage.setItem('deskchan-theme', t);
        };

        if (t === 'auto') {
            // Listen to system theme changes while in auto mode. The class
            // toggle must happen HERE (inside the media-query handler), not
            // in the effect body: this effect only re-runs when `theme()`
            // changes, so a system light/dark switch used to update the
            // (unconsumed) signal but never repaint the app.
            const mq = window.matchMedia('(prefers-color-scheme: dark)');
            const handler = (e: MediaQueryListEvent) => {
                apply(e.matches ? 'dark' : 'light');
            };
            mq.addEventListener('change', handler);
            onCleanup(() => mq.removeEventListener('change', handler));
            apply(mq.matches ? 'dark' : 'light');
        } else {
            apply(t);
        }
    });

    const value: ThemeContextValue = { theme, setTheme, resolvedTheme };

    return (
        <ThemeContext.Provider value={value}>
            {props.children}
        </ThemeContext.Provider>
    );
}

/**
 * Hook to access theme within a SolidJS component.
 */
export function useTheme(): ThemeContextValue {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
    return ctx;
}
