import { describe, expect, it } from 'vitest';
import { toggleDesktopContentVisibility } from './desktop-visibility';

describe('toggleDesktopContentVisibility', () => {
    it('toggles visibility between visible and hidden states', () => {
        expect(toggleDesktopContentVisibility(true)).toBe(false);
        expect(toggleDesktopContentVisibility(false)).toBe(true);
    });
});
