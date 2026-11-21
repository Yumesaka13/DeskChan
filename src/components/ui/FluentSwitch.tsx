/** Labeled Fluent switch with native keyboard and screen-reader behavior. */
import { Switch } from '@kobalte/core/switch';
import { cn } from '~/lib/utils';

interface FluentSwitchProps {
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
    class?: string;
    trackClass?: string;
}

export default function FluentSwitch(props: FluentSwitchProps) {
    return (
        <Switch class={cn('fluent-switch', props.class)} checked={props.checked} onChange={props.onChange}>
            <Switch.Input class="fluent-switch-input" aria-label={props.label} />
            <Switch.Control class={cn('fluent-switch-track', props.trackClass)}>
                <Switch.Thumb class="fluent-switch-thumb" />
            </Switch.Control>
        </Switch>
    );
}
