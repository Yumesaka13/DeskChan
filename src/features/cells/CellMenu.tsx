import { FiCheck, FiPlus, FiTrash2 } from 'solid-icons/fi';
import type { Cell } from '@bindings/Cell';
import type { CellLayout } from '@bindings/CellLayout';
import type { SubStyle } from '@bindings/SubStyle';
import type { SortDirection, SortField } from '~/lib/grid';
import type { Point } from '~/lib/monitor';
import ContextMenu, { type MenuItem } from '~/components/ui/ContextMenu';
import { useI18n } from '~/i18n';

export interface CellMenuCommands {
    createTab: () => void;
    toggleTitle: () => void;
    changeLayout: (layout: CellLayout) => void;
    sort: (field: SortField, direction: SortDirection) => void;
    changeTabStyle: (style: SubStyle) => void;
    deleteCell: () => void;
    deleteTab: (id: string) => void;
}

interface CellMenuProps {
    cell: Cell;
    position: Point;
    tabId?: string;
    commands: CellMenuCommands;
    onClose: () => void;
}

export default function CellMenu(props: CellMenuProps) {
    const { t } = useI18n();
    const mark = (checked: boolean) => (checked ? <FiCheck /> : undefined);
    const sortField = (): SortField =>
        props.cell.sort_field === 'type' || props.cell.sort_field === 'modified'
            ? props.cell.sort_field
            : 'name';
    const sortDirection = (): SortDirection => (props.cell.sort_direction === 'desc' ? 'desc' : 'asc');

    function items(): MenuItem[] {
        const tabId = props.tabId;
        if (tabId)
            return [
                {
                    label: t('cell.context.delete_sub'),
                    icon: <FiTrash2 />,
                    destructive: true,
                    onClick: () => props.commands.deleteTab(tabId),
                },
            ];

        const entries: MenuItem[] = [
            { label: t('cell.context.new_sub'), icon: <FiPlus />, onClick: props.commands.createTab },
            {
                label: t('cell.context.show_title'),
                icon: mark(props.cell.show_title),
                onClick: props.commands.toggleTitle,
            },
            {
                label: t('cell.context.arrangement'),
                submenu: [
                    ...(['Grid', 'List'] as const).map((layout) => ({
                        label: t(layout === 'Grid' ? 'cell.layout.grid' : 'cell.layout.list'),
                        icon: mark(props.cell.layout === layout),
                        onClick: () => props.commands.changeLayout(layout),
                    })),
                    { separator: true },
                    {
                        label: t('desktop.context.arrange_auto'),
                        onClick: () => props.commands.sort(sortField(), sortDirection()),
                    },
                    {
                        label: t('desktop.context.sort_by'),
                        submenu: (['name', 'type', 'modified'] as const).map((field) => ({
                            label: t(`desktop.context.sort_${field}`),
                            icon: mark(sortField() === field),
                            onClick: () => props.commands.sort(field, sortDirection()),
                        })),
                    },
                    {
                        label: t('desktop.context.sort_direction'),
                        submenu: (['asc', 'desc'] as const).map((direction) => ({
                            label: t(
                                direction === 'asc'
                                    ? 'desktop.context.sort_ascending'
                                    : 'desktop.context.sort_descending',
                            ),
                            icon: mark(sortDirection() === direction),
                            onClick: () => props.commands.sort(sortField(), direction),
                        })),
                    },
                ],
            },
        ];
        if (props.cell.sub_cells.length)
            entries.push({
                label: t('cell.context.sub_style'),
                submenu: (['Compact', 'Stretch'] as const).map((style) => ({
                    label: t(style === 'Compact' ? 'cell.sub_style.compact' : 'cell.sub_style.stretch'),
                    icon: mark(props.cell.sub_style === style),
                    onClick: () => props.commands.changeTabStyle(style),
                })),
            });
        entries.push(
            { separator: true },
            {
                label: t('cell.context.delete_cell'),
                icon: <FiTrash2 />,
                destructive: true,
                onClick: props.commands.deleteCell,
            },
        );
        return entries;
    }

    return <ContextMenu items={items()} position={props.position} onClose={props.onClose} />;
}
