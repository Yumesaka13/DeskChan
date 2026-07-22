import {
    createContext,
    useContext,
    createSignal,
    createEffect,
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
        let resolved: 'light' | 'dark';

        if (t === 'auto') {
            resolved = window.matchMedia('(prefers-color-scheme: dark)').matches
                ? 'dark'
                : 'light';
            // Listen to system theme changes when in auto mode
            const mq = window.matchMedia('(prefers-color-scheme: dark)');
            const handler = (e: MediaQueryListEvent) => {
                setResolvedTheme(e.matches ? 'dark' : 'light');
            };
            mq.addEventListener('change', handler);
            // Cleanup not needed in Solid's createEffect — but we use a simple approach;
            // the listener will persist for the lifetime of the app.
        } else {
            resolved = t;
        }

        setResolvedTheme(resolved);
        document.documentElement.classList.toggle('dark', resolved === 'dark');
        localStorage.setItem('deskchan-theme', t);
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
