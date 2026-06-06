# notion-font-customizer

macOS Notion 桌面应用的自定义字体补丁工具。
通过向 Notion 的 Electron asar 包注入 CSS 热重载，实现无需重启即可实时更换字体。

[English](README.md)

## 功能特性

- 解包并修补 Notion 的 `app.asar`
- 通过 Electron IPC 注入 CSS 热重载
- 监听 `~/.config/notion/custom.css` 文件变更，实时生效
- 可读取 notion-stylish 使用的同一份 GitHub Gist `notion-stylish.json`
- 使用稳定的本地代码签名身份重签应用包
- 支持一键还原至原始状态

## 环境要求

- macOS
- Node.js >= 18

## 使用方式

### 即用（无需安装）

```bash
npx github:xupeng/notion-font-customizer          # 应用补丁
npx github:xupeng/notion-font-customizer --restore  # 还原原始状态
npx github:xupeng/notion-font-customizer --configure-gist --gist-id abc123
```

### 全局安装

```bash
npm install -g github:xupeng/notion-font-customizer
notion-font-customizer          # 应用补丁
notion-font-customizer --restore  # 还原原始状态
notion-font-customizer --configure-gist --gist-id abc123
nfc                              # apply 的简短别名
nfc --restore                    # restore 的简短别名
```

## 工作原理

1. 在应用包外备份 `app.asar` 和 `Info.plist`
2. 解包 asar，向 `preload.js` 和 `main/index.js` 注入 IPC 代码
3. 重新打包 asar，更新 `Info.plist` 中的 header hash
4. 使用稳定的本地代码签名身份重签 `Notion.app`
5. 在 `~/.config/notion/custom.css` 创建默认样式文件

编辑 `custom.css` 即可更换字体，修改通过热重载立即生效。

## GitHub Gist 样式来源

如果要复用 `notion-stylish` 的同一份样式来源，配置 Gist ID：

```bash
notion-font-customizer --configure-gist --gist-id abc123
```

工具会在 Notion 启动时读取该 Gist 中的 `notion-stylish.json`。只读模式下
GitHub token 是可选的：

```bash
notion-font-customizer --configure-gist --gist-id abc123 --github-token ghp_xxx
```

配置写入 `~/.config/notion/gist.json`，并使用本地私有文件权限。token 不会写入缓存。
有效的远端快照会缓存到 `~/.config/notion/gist-cache.json`；如果远端和缓存都不可用，
则回退到本地 `custom.css`。

禁用 Gist 来源并回到本地 `custom.css` 热重载模式：

```bash
notion-font-customizer --disable-gist
```

## Google Fonts

开箱即用，无需额外配置 —— CSP 已自动放宽，preconnect 预连接也会自动注入。

1. 在 [fonts.google.com](https://fonts.google.com) 找到字体，复制其 `@import` URL。
2. 将以下内容加入 `~/.config/notion/custom.css`：

```css
@import url('https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;700&display=swap');

div.notion-page-content * {
    font-family: 'Noto Serif SC', serif !important;
}
```

修改后热重载立即生效，无需重启 Notion。

## Notion 更新后

重新运行补丁工具即可。该工具会自动检测版本变更并刷新备份。

首次运行会在 login keychain 中创建名为 `Notion Font Customizer Local Code Signing`
的本地自签代码签名身份。补丁后的 Notion 仍不再使用官方开发者证书签名，但同一台
Mac 上后续 patch 和 restore 会复用这个本地身份。

## 许可证

MIT
