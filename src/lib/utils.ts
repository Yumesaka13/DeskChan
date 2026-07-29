// Minimal cn() implementation - merges class names without external deps.
// Supports strings, arrays, and conditional objects.

type CnInput = string | number | boolean | null | undefined | CnInput[] | Record<string, unknown>;

/**
 * Merge class names with conditional support.
 * Usage: cn('base', condition && 'active', ['flex', 'gap-2'])
 */
export function cn(...inputs: CnInput[]): string {
    const result: string[] = [];

    for (const input of inputs) {
        if (!input) continue;
        if (typeof input === 'string') {
            // Split by whitespace so "foo bar" becomes two tokens
            result.push(...input.split(/\s+/).filter(Boolean));
        } else if (Array.isArray(input)) {
            const nested = cn(...input);
            if (nested) result.push(nested);
        } else if (typeof input === 'object') {
            for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
                if (value) result.push(key);
            }
        }
    }

    return result.join(' ');
}
