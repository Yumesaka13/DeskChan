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
    'app.name': 'DeskChan \u684C\u9762\u76D2\u5B50',
    'app.desc': '\u684C\u9762\u5206\u533A\u76D2\u5B50\u5DE5\u5177',

    'cell.empty_hint': '\u62D6\u5165\u56FE\u6807',
    'cell.context.new_sub': '\u521B\u5EFA\u5B50\u76D2\u5B50',
    'cell.context.delete_sub': '\u5220\u9664\u5B50\u76D2\u5B50',
    'cell.context.sub_style': '\u5B50\u683C\u5B50\u6837\u5F0F',
    'cell.context.arrangement': '\u6392\u5217\u65B9\u5F0F',
    'cell.layout.grid': '\u7F51\u683C',
    'cell.layout.list': '\u5217\u8868',
    'cell.sub_style.compact': '\u7D27\u51D1',
    'cell.sub_style.stretch': '\u81EA\u9002\u5E94\u5360\u6EE1',
    'cell.context.show_title': '\u663E\u793A\u6807\u9898',
    'cell.context.delete_cell': '\u5220\u9664\u683C\u5B50',
    'cell.hover_expand': '\u60AC\u505C\u65F6\u81EA\u52A8\u5C55\u5F00',

    'icon.remove': '\u79FB\u9664\u56FE\u6807',
    'icon.open_file': '\u6253\u5F00\u6587\u4EF6',
    'icon.open_with': '\u9009\u62e9\u5176\u4ed6\u5e94\u7528\u6253\u5f00',
    'icon.rename': '\u91CD\u547D\u540D',
    'icon.exclude_organize': '\u4e0d\u53c2\u4e0e\u4e00\u952e\u6574\u7406',
    'icon.cut': '\u526a\u5207',
    'icon.copy': '\u590d\u5236',
    'icon.delete': '\u5220\u9664',
    'icon.properties': '\u5c5e\u6027',
    'icon.system_menu': '\u66f4\u591a\u7cfb\u7edf\u9009\u9879',

    'desktop.empty': '\u53F3\u952E\u521B\u5EFA\u65B0\u683C\u5B50\u5F00\u59CB\u4F7F\u7528',
    'desktop.context.new_cell': '\u65B0\u5EFA\u683C\u5B50',
    'desktop.context.refresh': '\u5237\u65B0',
    'desktop.context.paste': '\u7c98\u8d34\u5230\u684c\u9762',
    'desktop.context.paste_copy': '\u590d\u5236\u5230\u6b64\u5904',
    'desktop.context.paste_move': '\u79fb\u52a8\u5230\u6b64\u5904',
    'desktop.context.settings': '\u8BBE\u7F6E',
    'desktop.context.organize': '\u4E00\u952E\u6574\u7406',
    'desktop.context.arrangement': '\u6392\u5217\u65B9\u5F0F',
    'desktop.context.arrange_auto': '\u81EA\u52A8\u6392\u5217',
    'desktop.context.arrange_snap': '\u5BF9\u9F50\u5230\u7F51\u683C',
    'desktop.context.sort_by': '\u6392\u5e8f\u4f9d\u636e',
    'desktop.context.sort_name': '\u540d\u79f0',
    'desktop.context.sort_type': '\u7c7b\u578b',
    'desktop.context.sort_modified': '\u4fee\u6539\u65e5\u671f',
    'desktop.context.sort_direction': '\u6392\u5e8f\u65b9\u5411',
    'desktop.context.sort_ascending': '\u5347\u5e8f',
    'desktop.context.sort_descending': '\u964d\u5e8f',
    'desktop.context.personalize': '\u4E2A\u6027\u5316',
    'desktop.context.display_settings': '\u663E\u793A\u8BBE\u7F6E',
    'desktop.context.system_menu': '\u66F4\u591A\u7CFB\u7EDF\u9009\u9879',
    'desktop.context.exit': '\u9000\u51FA DeskChan',

    'organize.folders': '\u6587\u4EF6\u5939',
    'organize.apps': '\u5E94\u7528',
    'organize.documents': '\u6587\u6863',
    'organize.images': '\u56FE\u7247',
    'organize.media': '\u5F71\u97F3',
    'organize.archives': '\u538B\u7F29\u5305',
    'organize.others': '\u5176\u4ED6',

    'toast.load_config_failed': '\u52A0\u8F7D\u914D\u7F6E\u5931\u8D25',
    'toast.open_file_failed': '\u6253\u5F00\u6587\u4EF6\u5931\u8D25',
    'toast.file_action_failed': '\u6587\u4ef6\u64cd\u4f5c\u5931\u8d25',
    'toast.rename_failed': '\u91CD\u547D\u540D\u5931\u8D25',
    'toast.open_settings_failed': '\u65E0\u6CD5\u6253\u5F00\u7CFB\u7EDF\u8BBE\u7F6E',
    'toast.drop_failed': '\u65E0\u6CD5\u63A5\u6536\u62D6\u5165\u7684\u6587\u4EF6',
    'toast.paste_failed': '\u65e0\u6cd5\u7c98\u8d34\u526a\u8d34\u677f\u4e2d\u7684\u6587\u4ef6',
    'toast.sort_failed': '\u6392\u5e8f\u5931\u8d25',
    'toast.organize_failed': '\u6574\u7406\u5931\u8D25',
    'toast.reset_done': '\u5DF2\u6062\u590D\u5230\u521D\u59CB\u72B6\u6001',
    'toast.export_done': '\u914D\u7F6E\u5DF2\u5BFC\u51FA',
    'toast.export_failed': '\u5BFC\u51FA\u5931\u8D25',
    'toast.import_done': '\u914D\u7F6E\u5DF2\u5BFC\u5165',
    'toast.import_failed': '\u5BFC\u5165\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u6587\u4EF6\u662F\u5426\u6709\u6548',

    'history.title': '\u64CD\u4F5C\u5386\u53F2',
    'history.empty': '\u6682\u65E0\u53EF\u64A4\u9500\u7684\u64CD\u4F5C',
    'history.edit_cell': '\u4FEE\u6539\u683C\u5B50',
    'history.move_into_cell': '\u79FB\u52A8\u56FE\u6807',
    'history.add_icon': '\u6DFB\u52A0\u56FE\u6807',
    'history.create_cell': '\u65B0\u5EFA\u683C\u5B50',
    'history.organize': '\u4E00\u952E\u6574\u7406',
    'history.sort': '\u6392\u5E8F\u56FE\u6807',
    'history.file_move': '\u79FB\u52A8\u6587\u4EF6',
    'history.file_copy': '\u590D\u5236\u6587\u4EF6',
    'history.file_delete': '\u79FB\u5165\u56DE\u6536\u7AD9',
    'history.file_rename': '\u91CD\u547D\u540D\u6587\u4EF6',

    'default.cell_title': '\u683C\u5B50',
    'default.sub_title': '\u5B50\u76D2\u5B50',
    'default.icon_name': '\u672A\u77E5',

    'settings.theme': '\u4E3B\u9898',
    'settings.desktop_opacity': '\u684c\u9762\u906e\u7f69\u900f\u660e\u5ea6',
    'settings.file_menu': '\u6587\u4ef6\u53f3\u952e\u83dc\u5355',
    'settings.file_extensions': '\u663e\u793a\u6587\u4ef6\u6269\u5c55\u540d',
    'settings.file_extensions_show': '\u663e\u793a',
    'settings.file_extensions_hide': '\u9690\u85cf',
    'settings.file_menu_styled': '\u7f8e\u5316\u83dc\u5355',
    'settings.file_menu_native': '\u539f\u7248\u83dc\u5355',
    'settings.language': '\u8BED\u8A00',
    'settings.title': '\u8BBE\u7F6E',
    'settings.close': '\u5173\u95ED',
    'settings.tab.general': '\u901A\u7528',
    'settings.tab.appearance': '\u5916\u89C2',
    'settings.tab.data': '\u6570\u636E',
    'settings.export': '\u5BFC\u51FA\u914D\u7F6E',
    'settings.import': '\u5BFC\u5165\u914D\u7F6E',
    'settings.export_title': '\u5BFC\u51FA\u914D\u7F6E\u5230...',
    'settings.import_title': '\u9009\u62E9\u8981\u5BFC\u5165\u7684\u914D\u7F6E\u6587\u4EF6',
    'settings.reset': '\u91CD\u7F6E\u914D\u7F6E',
    'settings.reset_hint': '\u6062\u590D\u5230\u9996\u6B21\u8FD0\u884C\u65F6\u7684\u72B6\u6001\uFF0C\u6240\u6709\u683C\u5B50\u5C06\u88AB\u6E05\u9664',
    'settings.reset_confirm': '\u786E\u5B9A\u8981\u91CD\u7F6E\u914D\u7F6E\u5417\uFF1F\u6240\u6709\u683C\u5B50\u5C06\u88AB\u6E05\u9664\uFF0C\u684C\u9762\u56FE\u6807\u6062\u590D\u81EA\u52A8\u6392\u5217\u3002',

    'theme.light': '\u6D45\u8272',
    'theme.dark': '\u6DF1\u8272',
    'theme.auto': '\u81EA\u52A8',
};
