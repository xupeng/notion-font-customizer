# notion-font-customizer

macOS Notion 桌面应用的自定义字体补丁工具。
通过向 Notion 的 Electron asar 包注入 CSS 热重载，实现无需重启即可实时更换字体。

[English](README.md)

## 功能特性

- 解包并修补 Notion 的 `app.asar`
- 通过 Electron IPC 注入 CSS 热重载
- 监听 `~/.config/notion/custom.css` 文件变更，实时生效
- 对应用包进行临时重签名
- 支持一键还原至原始状态

## 环境要求

- macOS
- Node.js >= 18

## 使用方式

> 向 `/Applications` 写入文件需要 `sudo` 权限。

### 即用（无需安装）

```bash
sudo npx github:xupeng/notion-font-customizer          # 应用补丁
sudo npx github:xupeng/notion-font-customizer --restore  # 还原原始状态
```

### 全局安装

```bash
npm install -g github:xupeng/notion-font-customizer
sudo notion-font-customizer          # 应用补丁
sudo notion-font-customizer --restore  # 还原原始状态
sudo nfc                              # apply 的简短别名
sudo nfc --restore                    # restore 的简短别名
```

## 工作原理

1. 备份 `app.asar` 和 `Info.plist`
2. 解包 asar，向 `preload.js` 和 `main/index.js` 注入 IPC 代码
3. 重新打包 asar，更新 `Info.plist` 中的 header hash
4. 对 `Notion.app` 进行临时重签名（ad-hoc）
5. 在 `~/.config/notion/custom.css` 创建默认样式文件

编辑 `custom.css` 即可更换字体，修改通过热重载立即生效。

## Notion 更新后

重新运行补丁工具即可。该工具会自动检测版本变更并刷新备份。

## 许可证

MIT
