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
    'cell.collapse': string;
    'cell.expand': string;
    'cell.hover_expand': string;

    // Icon
    'icon.remove': string;
    'icon.open_file': string;

    // Desktop
    'desktop.empty': string;
    'desktop.context.new_cell': string;
    'desktop.context.refresh': string;
    'desktop.context.settings': string;
    'desktop.context.organize': string;
    'desktop.context.arrangement': string;
    'desktop.context.arrange_auto': string;
    'desktop.context.arrange_snap': string;
    'desktop.context.exit': string;

    // Organize categories (cell titles)
    'organize.folders': string;
    'organize.apps': string;
    'organize.documents': string;
    'organize.images': string;
    'organize.media': string;
    'organize.archives': string;
    'organize.others': string;

    // Toast messages
    'toast.load_config_failed': string;
    'toast.open_file_failed': string;
    'toast.organize_failed': string;
    'toast.reset_done': string;
    'toast.export_done': string;
    'toast.export_failed': string;
    'toast.import_done': string;
    'toast.import_failed': string;

    // Defaults
    'default.cell_title': string;
    'default.icon_name': string;
    'default.add_files_title': string;

    // Settings
    'settings.theme': string;
    'settings.language': string;
    'settings.show_titles': string;
    'settings.title': string;
    'settings.save': string;
    'settings.cancel': string;
    'settings.tab.general': string;
    'settings.tab.appearance': string;
    'settings.tab.data': string;
    'settings.export': string;
    'settings.import': string;
    'settings.export_title': string;
    'settings.import_title': string;
    'settings.reset': string;
    'settings.reset_hint': string;
    'settings.reset_confirm': string;

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
    'cell.collapse': '折叠',
    'cell.expand': '展开',
    'cell.hover_expand': '悬停时自动展开',

    'icon.remove': '移除图标',
    'icon.open_file': '打开文件',

    'desktop.empty': '右键创建新格子开始使用',
    'desktop.context.new_cell': '新建格子',
    'desktop.context.refresh': '刷新',
    'desktop.context.settings': '设置',
    'desktop.context.organize': '一键整理',
    'desktop.context.arrangement': '排列方式',
    'desktop.context.arrange_auto': '自动排列',
    'desktop.context.arrange_snap': '对齐到网格',
    'desktop.context.exit': '退出 DeskChan',

    'organize.folders': '文件夹',
    'organize.apps': '应用',
    'organize.documents': '文档',
    'organize.images': '图片',
    'organize.media': '影音',
    'organize.archives': '压缩包',
    'organize.others': '其他',

    'toast.load_config_failed': '加载配置失败',
    'toast.open_file_failed': '打开文件失败',
    'toast.organize_failed': '整理失败',
    'toast.reset_done': '已恢复到初始状态',
    'toast.export_done': '配置已导出',
    'toast.export_failed': '导出失败',
    'toast.import_done': '配置已导入',
    'toast.import_failed': '导入失败，请检查文件是否有效',

    'default.cell_title': '格子',
    'default.icon_name': '未知',
    'default.add_files_title': '选择要添加的文件',

    'settings.theme': '主题',
    'settings.language': '语言',
    'settings.show_titles': '显示标题',
    'settings.title': '设置',
    'settings.save': '保存',
    'settings.cancel': '取消',
    'settings.tab.general': '通用',
    'settings.tab.appearance': '外观',
    'settings.tab.data': '数据',
    'settings.export': '导出配置',
    'settings.import': '导入配置',
    'settings.export_title': '导出配置到…',
    'settings.import_title': '选择要导入的配置文件',
    'settings.reset': '重置配置',
    'settings.reset_hint': '恢复到首次运行时的状态，所有格子将被清除',
    'settings.reset_confirm': '确定要重置配置吗？所有格子将被清除，桌面图标恢复自动排列。',

    'theme.light': '浅色',
    'theme.dark': '深色',
    'theme.auto': '自动',
};
