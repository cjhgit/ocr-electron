# 外部插件配置说明

## 概述

系统支持从任意位置加载插件，无需将插件复制到项目目录。这样可以：
- 方便开发和调试插件
- 与其他工具共享插件（如 ZTools）
- 保持项目目录整洁

## 配置步骤

### 1. 创建配置文件

复制示例文件：

```bash
cp data/external-plugins.example.json data/external-plugins.json
```

### 2. 添加插件路径

编辑 `data/external-plugins.json`，添加你的插件路径：

```json
[
  {
    "path": "/Users/yunser/app/ztools-hello"
  },
  {
    "path": "/Users/yunser/app/my-custom-plugin"
  }
]
```

### 3. 重启应用

保存配置后，重启应用即可看到外部插件。

## 示例：加载 ztools-hello 插件

ztools-hello 是一个简单的 ZTools 插件，可以直接加载：

```json
[
  {
    "path": "/Users/yunser/app/ztools-hello"
  }
]
```

插件结构：
```
ztools-hello/
├── plugin.json    # 插件配置
├── index.html     # 主页面
└── logo.png       # 图标
```

## 注意事项

1. **路径必须是绝对路径**
   - ✅ 正确：`/Users/yunser/app/ztools-hello`
   - ❌ 错误：`../ztools-hello` 或 `~/app/ztools-hello`

2. **配置文件不会被提交到 git**
   - `data/external-plugins.json` 已添加到 `.gitignore`
   - 每个开发者可以有自己的外部插件配置

3. **插件必须包含 plugin.json**
   - 系统会读取 `plugin.json` 获取插件信息
   - 至少需要包含：`name`、`title`、`main` 字段

4. **支持的插件格式**
   - 兼容 ZTools 插件格式
   - 使用 `logo` 或 `icon` 字段指定图标
   - 支持 `preload` 脚本

## 插件兼容性

### ZTools 插件兼容性

系统基本兼容 ZTools 插件格式：

✅ 支持的功能：
- 基本的 HTML/CSS/JS 插件
- plugin.json 配置
- logo/icon 图标
- preload 脚本

❌ 暂不支持的功能：
- ZTools 特定 API（features、cmds 等）
- 插件生命周期钩子
- 系统集成功能

## 常见问题

### Q: 添加外部插件后看不到？

A: 检查以下几点：
1. 路径是否正确（绝对路径）
2. 插件目录是否包含 `plugin.json`
3. `plugin.json` 格式是否正确
4. 是否重启了应用

### Q: 可以同时加载多个外部插件吗？

A: 可以，在配置文件中添加多个插件路径即可。

### Q: 外部插件会被复制到项目中吗？

A: 不会，系统直接从外部路径加载，不会复制文件。

## 开发建议

如果你正在开发插件：

1. 在任意位置创建插件目录
2. 添加到 `data/external-plugins.json`
3. 修改插件代码后刷新即可看到效果
4. 无需复制或安装步骤
