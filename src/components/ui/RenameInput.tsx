/** Inline rename control shared by file icons, fences and fence tabs. */
import { onMount } from 'solid-js';
import { cn } from '~/lib/utils';

interface RenameInputProps {
    label: string;
    value: string;
    selectStem?: boolean;
    onCommit: (value: string) => void | Promise<void>;
    onCancel: () => void;
    class?: string;
}

export default function RenameInput(props: RenameInputProps) {
    let input!: HTMLInputElement;
    let finished = false;
    onMount(() => {
        input.focus();
        const end = props.selectStem ? input.value.lastIndexOf('.') : -1;
        input.setSelectionRange(0, end > 0 ? end : input.value.length);
    });

    function commit() {
        if (finished) return;
        finished = true;
        const value = input.value.trim();
        if (value && value !== props.value) {
            void Promise.resolve(props.onCommit(value)).finally(() => {
                finished = false;
            });
        } else props.onCancel();
    }

    return (
        <input
            ref={input}
            aria-label={props.label}
            value={props.value}
            class={cn('fluent-rename', props.class)}
            onBlur={commit}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onDblClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') commit();
                else if (event.key === 'Escape') {
                    finished = true;
                    props.onCancel();
                }
            }}
        />
    );
}
