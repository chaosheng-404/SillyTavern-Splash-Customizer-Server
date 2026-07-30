# SillyTavern Splash Customizer Server

这是“启动画面设计器”的服务器配套插件，负责：

- 在 SillyTavern 启动第一帧加载自定义画面样式。
- 保存启动画面配置与预设。
- 安全提取字体样式表中的 `@font-face`。
- 保存并提供 WOFF2、WOFF、TTF、OTF 字体文件。

前端扩展仓库：
[SillyTavern-Splash-Customizer](https://github.com/chaosheng-404/SillyTavern-Splash-Customizer)

## 一条命令安装

先关闭 SillyTavern，然后在 **SillyTavern 根目录**执行：

```sh
node plugins.js install https://github.com/chaosheng-404/SillyTavern-Splash-Customizer-Server && node plugins/SillyTavern-Splash-Customizer-Server/install.cjs
```

这条单行命令适用于 Termux、Linux、macOS、Windows CMD、PowerShell 7 和 Windows Terminal。旧版 Windows PowerShell 5 请使用下方的分步安装命令。

安装脚本会：

1. 验证当前目录确实是 SillyTavern。
2. 首次修改前备份 `config.yaml` 为 `config.yaml.splash-customizer.bak`。
3. 启用 `enableServerPlugins: true`。
4. 启用 `enableServerPluginsAutoUpdate: true`。

完成后重启 SillyTavern。

电脑端与手机 Termux 的完整图文式步骤、使用方法和常见问题请查看[前端扩展 README](https://github.com/chaosheng-404/SillyTavern-Splash-Customizer#安装前准备)。

## 分步安装

```sh
node plugins.js install https://github.com/chaosheng-404/SillyTavern-Splash-Customizer-Server
node plugins/SillyTavern-Splash-Customizer-Server/install.cjs
```

如果仓库被放在了其他目录，可以显式指定 SillyTavern 根目录：

```sh
node /path/to/install.cjs --root /path/to/SillyTavern
```

## 更新

启用 `enableServerPluginsAutoUpdate` 后，SillyTavern 会在启动时自动更新通过 Git 安装的服务器插件。
