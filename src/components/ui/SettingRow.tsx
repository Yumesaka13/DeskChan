/** Form row with a label, optional description, and an aligned control. */
import { Show, type JSX } from 'solid-js';
import { cn } from '~/lib/utils';

interface SettingRowProps {
    label: string;
    id?: string;
    description?: string;
    children: JSX.Element;
    class?: string;
    controlClass?: string;
}

export default function SettingRow(props: SettingRowProps) {
    return (
        <div class={cn('settings-row', props.class)}>
            <div class="settings-row-copy">
                <Show when={props.id} fallback={<div class="settings-label">{props.label}</div>}>
                    {(id) => (
                        <label class="settings-label" for={id()}>
                            {props.label}
                        </label>
                    )}
                </Show>
                <Show when={props.description}>
                    <div class="settings-description">{props.description}</div>
                </Show>
            </div>
            <div class={cn('settings-control', props.controlClass)}>{props.children}</div>
        </div>
    );
}
