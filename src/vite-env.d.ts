/// <reference types="vite/client" />

// UnoCSS virtual module
declare module 'virtual:uno.css' {
    const _: void;
    export default _;
}

// SolidJS JSX
import type { JSX as SolidJSX } from 'solid-js';

declare global {
    namespace JSX {
        interface IntrinsicElements extends SolidJSX.IntrinsicElements {}
    }

    interface Window {
        __TAURI__?: {
            window?: {
                getCurrentWindow: () => {
                    onDragDropEvent?: (callback: (event: {
                        payload: { type: string; paths?: string[]; position?: { x: number; y: number } };
                    }) => void) => () => void;
                };
            };
        };
    }
}

export {};
