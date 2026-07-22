# 数据库文件命名规则

## 当前实现

插件数据文件命名使用 `plugin.json` 中的 `name` 字段：

```
json-db/
├── main.json              # 主程序数据
├── attachments.json       # 附件
└── plugins/
    ├── todo-plugin.json   # name: "todo-plugin"
    ├── plugin-test.json   # name: "plugin-test"
    └── ...
```

## 命名逻辑

```typescript
// 打开插件时
const { id, path: pluginPath, config } = pluginData
currentPluginId = config.name || id  // 优先使用 config.name

// 数据存储
// PLUGIN/todo-plugin/todos -> 存储到 plugins/todo-plugin.json
// PLUGIN/plugin-test/config -> 存储到 plugins/plugin-test.json
```

## 示例

### plugin.json
```json
{
  "name": "todo-plugin",
  "description": "待办事项管理",
  "version": "1.0.0",
  "main": "index.html"
}
```

### 数据文件路径
```
plugins/todo-plugin.json
```

### 数据文件内容
```json
{
  "docs": {
    "todos": {
      "_id": "PLUGIN/todo-plugin/todos",
      "_rev": "1-xxx",
      "value": [...]
    },
    "config": {
      "_id": "PLUGIN/todo-plugin/config",
      "_rev": "1-yyy",
      "theme": "dark"
    }
  },
  "meta": {
    "todos": { ... },
    "config": { ... }
  }
}
```

## 优势

1. **可读性** - 文件名清晰表示插件功能
2. **稳定性** - name 字段不会轻易改变
3. **一致性** - 与插件标识符保持一致
4. **调试方便** - 直接通过文件名识别插件

## 注意事项

### name 字段规范

确保 `plugin.json` 中的 `name` 字段：
- ✅ 使用小写字母、数字和连字符
- ✅ 不包含空格和特殊字符
- ✅ 唯一且不重复
- ✅ 不要使用 `main`（保留给主程序）

**推荐格式**：
- `my-plugin`
- `todo-list`
- `calculator`
- `weather-app`

**不推荐**：
- `My Plugin` ❌ (包含空格和大写)
- `plugin@v2` ❌ (包含特殊字符)
- `main` ❌ (保留字)

### 迁移旧数据

如果插件的 `name` 字段改变了，需要手动迁移数据：

```bash
# 重命名数据文件
cd ~/Library/Application\ Support/Flow\ Chat/json-db/plugins/
mv old-name.json new-name.json

# 或删除旧数据（谨慎操作）
rm old-name.json
```

### 后备方案

如果 `config.name` 不存在，会使用传入的 `id` 作为后备：

```typescript
currentPluginId = config.name || id
```

## 与 ZTools 的兼容性

ZTools 也使用插件的 `name` 字段作为数据命名空间，因此这个实现与 ZTools 完全兼容。

### ZTools 数据前缀
```
PLUGIN/plugin-name/key
```

### 本项目数据前缀
```
PLUGIN/plugin-name/key  // 完全相同
```

### 存储位置
- **ZTools**: LMDB 数据库，按前缀分离
- **本项目**: JSON 文件，按插件名分离

虽然存储方式不同，但数据结构和命名规则完全一致，便于数据迁移。
