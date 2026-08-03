/** Translation keys - all UI strings used in the app. */
export interface Translations {
    // General
    'app.name': string;
    'app.desc': string;

    // Cell
    'cell.empty_hint': string;
    'cell.context.new_sub': string;
    'cell.context.delete_sub': string;
    'cell.context.sub_style': string;
    'cell.context.arrangement': string;
    'cell.layout.grid': string;
    'cell.layout.list': string;
    'cell.sub_style.compact': string;
    'cell.sub_style.stretch': string;
    'cell.context.show_title': string;
    'cell.context.delete_cell': string;
    'cell.hover_expand': string;

    // Icon
    'icon.remove': string;
    'icon.open_file': string;
    'icon.open_with': string;
    'icon.rename': string;
    'icon.exclude_organize': string;
    'icon.cut': string;
    'icon.copy': string;
    'icon.delete': string;
    'icon.properties': string;
    'icon.system_menu': string;

    // Desktop
    'desktop.empty': string;
    'desktop.context.new_cell': string;
    'desktop.context.refresh': string;
    'desktop.context.paste': string;
    'desktop.context.paste_copy': string;
    'desktop.context.paste_move': string;
    'desktop.context.settings': string;
    'desktop.context.organize': string;
    'desktop.context.arrangement': string;
    'desktop.context.arrange_auto': string;
    'desktop.context.arrange_snap': string;
    'desktop.context.sort_by': string;
    'desktop.context.sort_name': string;
    'desktop.context.sort_type': string;
    'desktop.context.sort_modified': string;
    'desktop.context.sort_direction': string;
    'desktop.context.sort_ascending': string;
    'desktop.context.sort_descending': string;
    'desktop.context.personalize': string;
    'desktop.context.display_settings': string;
    'desktop.context.system_menu': string;
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
    'toast.file_action_failed': string;
    'toast.rename_failed': string;
    'toast.open_settings_failed': string;
    'toast.drop_failed': string;
    'toast.paste_failed': string;
    'toast.sort_failed': string;
    'toast.organize_failed': string;
    'toast.reset_done': string;
    'toast.export_done': string;
    'toast.export_failed': string;
    'toast.import_done': string;
    'toast.import_failed': string;

    // History
    'history.title': string;
    'history.empty': string;
    'history.edit_cell': string;
    'history.move_into_cell': string;
    'history.add_icon': string;
    'history.create_cell': string;
    'history.organize': string;
    'history.sort': string;
    'history.file_move': string;
    'history.file_copy': string;
    'history.file_delete': string;
    'history.file_rename': string;

    // Defaults
    'default.cell_title': string;
    'default.sub_title': string;
    'default.icon_name': string;

    // Settings
    'settings.theme': string;
    'settings.desktop_opacity': string;
    'settings.file_menu': string;
    'settings.file_extensions': string;
    'settings.file_extensions_show': string;
    'settings.file_extensions_hide': string;
    'settings.file_menu_styled': string;
    'settings.file_menu_native': string;
    'settings.language': string;
    'settings.title': string;
    'settings.close': string;
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

    'cell.empty_hint': '拖入图标',
    'cell.context.new_sub': '创建子盒子',
    'cell.context.delete_sub': '删除子盒子',
    'cell.context.sub_style': '子格子样式',
    'cell.context.arrangement': '排列方式',
    'cell.layout.grid': '网格',
    'cell.layout.list': '列表',
    'cell.sub_style.compact': '紧凑',
    'cell.sub_style.stretch': '自适应占满',
    'cell.context.show_title': '显示标题',
    'cell.context.delete_cell': '删除格子',
    'cell.hover_expand': '悬停时自动展开',

    'icon.remove': '移除图标',
    'icon.open_file': '打开文件',
    'icon.open_with': '选择其他应用打开',
    'icon.rename': '重命名',
    'icon.exclude_organize': '不参与一键整理',
    'icon.cut': '剪切',
    'icon.copy': '复制',
    'icon.delete': '删除',
    'icon.properties': '属性',
    'icon.system_menu': '更多系统选项',

    'desktop.empty': '右键创建新格子开始使用',
    'desktop.context.new_cell': '新建格子',
    'desktop.context.refresh': '刷新',
    'desktop.context.paste': '粘贴到桌面',
    'desktop.context.paste_copy': '复制到此处',
    'desktop.context.paste_move': '移动到此处',
    'desktop.context.settings': '设置',
    'desktop.context.organize': '一键整理',
    'desktop.context.arrangement': '排列方式',
    'desktop.context.arrange_auto': '自动排列',
    'desktop.context.arrange_snap': '对齐到网格',
    'desktop.context.sort_by': '排序依据',
    'desktop.context.sort_name': '名称',
    'desktop.context.sort_type': '类型',
    'desktop.context.sort_modified': '修改日期',
    'desktop.context.sort_direction': '排序方向',
    'desktop.context.sort_ascending': '升序',
    'desktop.context.sort_descending': '降序',
    'desktop.context.personalize': '个性化',
    'desktop.context.display_settings': '显示设置',
    'desktop.context.system_menu': '更多系统选项',
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
    'toast.file_action_failed': '文件操作失败',
    'toast.rename_failed': '重命名失败',
    'toast.open_settings_failed': '无法打开系统设置',
    'toast.drop_failed': '无法接收拖入的文件',
    'toast.paste_failed': '无法粘贴剪贴板中的文件',
    'toast.sort_failed': '排序失败',
    'toast.organize_failed': '整理失败',
    'toast.reset_done': '已恢复到初始状态',
    'toast.export_done': '配置已导出',
    'toast.export_failed': '导出失败',
    'toast.import_done': '配置已导入',
    'toast.import_failed': '导入失败，请检查文件是否有效',

    'history.title': '操作历史',
    'history.empty': '暂无可撤销的操作',
    'history.edit_cell': '修改格子',
    'history.move_into_cell': '移动图标',
    'history.add_icon': '添加图标',
    'history.create_cell': '新建格子',
    'history.organize': '一键整理',
    'history.sort': '排序图标',
    'history.file_move': '移动文件',
    'history.file_copy': '复制文件',
    'history.file_delete': '移入回收站',
    'history.file_rename': '重命名文件',

    'default.cell_title': '格子',
    'default.sub_title': '子盒子',
    'default.icon_name': '未知',

    'settings.theme': '主题',
    'settings.desktop_opacity': '桌面遮罩透明度',
    'settings.file_menu': '文件右键菜单',
    'settings.file_extensions': '显示文件扩展名',
    'settings.file_extensions_show': '显示',
    'settings.file_extensions_hide': '隐藏',
    'settings.file_menu_styled': '美化菜单',
    'settings.file_menu_native': '原版菜单',
    'settings.language': '语言',
    'settings.title': '设置',
    'settings.close': '关闭',
    'settings.tab.general': '通用',
    'settings.tab.appearance': '外观',
    'settings.tab.data': '数据',
    'settings.export': '导出配置',
    'settings.import': '导入配置',
    'settings.export_title': '导出配置到...',
    'settings.import_title': '选择要导入的配置文件',
    'settings.reset': '重置配置',
    'settings.reset_hint': '恢复到首次运行时的状态，所有格子将被清除',
    'settings.reset_confirm': '确定要重置配置吗？所有格子将被清除，桌面图标恢复自动排列。',

    'theme.light': '浅色',
    'theme.dark': '深色',
    'theme.auto': '自动',
};
