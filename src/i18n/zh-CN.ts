/** Translation keys — all UI strings used in the app. */
export interface Translations {
    // General
    'app.name': string;
    'app.desc': string;

    // Cell
    'cell.new': string;
    'cell.delete': string;
    'cell.rename': string;
    'cell.empty_hint': string;
    'cell.context.add_icon': string;
    'cell.context.settings': string;
    'cell.context.delete_cell': string;

    // Icon
    'icon.remove': string;
    'icon.open_file': string;

    // Desktop
    'desktop.empty': string;
    'desktop.context.new_cell': string;
    'desktop.context.refresh': string;
    'desktop.context.settings': string;
    'desktop.context.reset': string;
    'desktop.context.exit': string;

    // Settings
    'settings.theme': string;
    'settings.language': string;
    'settings.show_titles': string;
    'settings.title': string;
    'settings.save': string;
    'settings.cancel': string;

    // Theme
    'theme.light': string;
    'theme.dark': string;
    'theme.auto': string;
}

export const zhCN: Translations = {
    'app.name': 'DeskChan 桌面盒子',
    'app.desc': '桌面分区盒子工具',

    'cell.new': '新建格子',
    'cell.delete': '删除格子',
    'cell.rename': '重命名',
    'cell.empty_hint': '拖入图标或右键添加',
    'cell.context.add_icon': '添加图标',
    'cell.context.settings': '格子设置',
    'cell.context.delete_cell': '删除格子',

    'icon.remove': '移除图标',
    'icon.open_file': '打开文件',

    'desktop.empty': '右键创建新格子开始使用',
    'desktop.context.new_cell': '新建格子',
    'desktop.context.refresh': '刷新',
    'desktop.context.settings': '设置',
    'desktop.context.reset': '重置配置',
    'desktop.context.exit': '退出 DeskChan',

    'settings.theme': '主题',
    'settings.language': '语言',
    'settings.show_titles': '显示标题',
    'settings.title': '设置',
    'settings.save': '保存',
    'settings.cancel': '取消',

    'theme.light': '浅色',
    'theme.dark': '深色',
    'theme.auto': '自动',
};
