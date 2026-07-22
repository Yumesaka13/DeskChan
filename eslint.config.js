import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import solid from 'eslint-plugin-solid';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        plugins: { solid },
        rules: {
            'solid/reactivity': 'warn',
            'solid/no-destructure': 'error',
            'solid/jsx-no-undef': 'error',
            '@typescript-eslint/no-explicit-any': 'warn',
            'no-console': 'off',
        },
    },
    {
        ignores: ['src-tauri/**', 'dist/**', 'node_modules/**'],
    },
);
