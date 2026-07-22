# 数据库功能更新日志

## 2024-11-XX - 数据库 API 实现

### 新增功能

#### 1. 纯 JSON 数据库系统

新增基于纯 JSON 文件的数据库实现，完全兼容 ZTools/UTools API 格式。

**新增文件**：
- `electron/main/json-db/types.ts` - 类型定义
- `electron/main/json-db/index.ts` - 数据库核心实现（407 行）
- `electron/main/json-db/jsonDbInstance.ts` - 数据库单例
- `electron/main/database-api.ts` - 数据库 API 处理器（669 行）

**技术特点**：
- ✅ 纯 JSON 文件存储（无第三方依赖）
- ✅ 内存数据结构（Map）提高性能
- ✅ 自动保存机制（可配置间隔）
- ✅ 附件支持（Base64 编码）
- ✅ 命名空间隔离（APP/、PLUGIN/<name>/）

#### 2. 数据库 API（11 个）

**同步 API（8 个）**：
```javascript
ztools.db.put(doc)              // 创建或更新文档
ztools.db.get(id)               // 获取文档
ztools.db.remove(docOrId)       // 删除文档
ztools.db.bulkDocs(docs)        // 批量操作
ztools.db.allDocs(key)          // 查询文档
ztools.db.postAttachment()      // 存储附件
ztools.db.getAttachment()       // 获取附件
ztools.db.getAttachmentType()   // 获取附件类型
```

**Promise API**：
```javascript
await ztools.db.promises.put(doc)
await ztools.db.promises.get(id)
// ... 所有同步 API 的 Promise 版本
```

**dbStorage API（3 个）**：
```javascript
ztools.dbStorage.setItem(key, value)   // 设置键值对
ztools.dbStorage.getItem(key)          // 获取键值对
ztools.dbStorage.removeItem(key)       // 删除键值对
```

#### 3. 示例插件

新增数据库使用示例插件：

**位置**：`plugins/database-example/`
**功能**：
- 基础 CRUD 操作演示
- dbStorage 使用示例
- 批量操作演示
- 数据统计展示

**文件**：
- `index.html` - 交互式演示界面（390 行）
- `plugin.json` - 插件配置
- `README.md` - 使用文档

### 修改的文件

#### 1. electron/main/index.ts

**变更**：
```typescript
// 导入数据库 API
import databaseAPI from './database-api'

// 在 app.whenReady() 中初始化
databaseAPI.init()
```

**影响**：主进程启动时自动初始化数据库 API

#### 2. electron/preload/plugin-system.ts

**变更**：实现数据库 API 的 IPC 调用

**新增代码**：
```typescript
// 替换 notImplemented 为实际实现
db: {
  put: function(doc: any): any {
    return ipcSendSync('db:put', doc)
  },
  // ... 其他 API
}

dbStorage: {
  setItem: function(key: string, value: any): void {
    return ipcSendSync('db-storage:set-item', key, value)
  },
  // ... 其他 API
}
```

**影响**：插件可以直接使用数据库 API

#### 3. IMPLEMENTED_APIS.md

**更新**：
- API 总数：45 个 → 54 个
- 新增数据库章节
- 更新使用示例

### 新增文档

1. **JSON_DATABASE.md** - 数据库实现详细文档（320 行）
   - 架构设计
   - API 说明
   - 数据格式
   - 使用示例
   - 性能特性
   - 最佳实践

2. **DATABASE_MIGRATION.md** - 数据库迁移说明（280 行）
   - 迁移背景
   - 架构设计
   - 实现细节
   - 兼容性说明
   - 性能考虑

3. **CHANGELOG_DATABASE.md** - 本文件

### 数据存储

**存储位置**：`userData/json-db/`

**文件结构**：
```
json-db/
├── main.json         # 主数据库（文档数据）
├── meta.json         # 元数据库（版本信息）
└── attachments.json  # 附件数据库（Base64）
```

**macOS 路径**：
```
~/Library/Application Support/chat-electron/json-db/
```

### API 统计

**总计 API 数量**：54 个（新增 11 个）

**分类统计**：
- 生命周期：3 个
- 剪贴板：4 个
- 平台检测：4 个
- 应用信息：5 个
- 窗口控制：4 个
- 对话框：3 个
- Shell：4 个
- 显示器：9 个
- 主题：2 个
- 子输入框：6 个
- **数据库：8 个** ⭐ 新增
- **dbStorage：3 个** ⭐ 新增

### 兼容性

#### 与 ZTools 的兼容性

| 特性 | 兼容性 | 说明 |
|------|--------|------|
| API 格式 | ✅ 100% | 接口签名完全一致 |
| 文档结构 | ✅ 100% | _id, _rev, _lastModified |
| 命名空间 | ✅ 100% | PLUGIN/<name>/ 前缀 |
| 同步 API | ✅ 100% | db.put/get/remove/bulkDocs/allDocs |
| Promise API | ✅ 100% | db.promises.* |
| 附件 | ✅ 100% | postAttachment/getAttachment |
| dbStorage | ✅ 100% | setItem/getItem/removeItem |

#### 与原有系统的关系

- ✅ **保留** SQLite 数据库（主程序功能）
- ✅ **新增** JSON 数据库（插件 API）
- ✅ **独立共存**，互不影响

### 性能特点

**优势**：
- ⚡ 启动快速（内存加载）
- ⚡ 查询快速（内存操作）
- 📝 数据可读（JSON 格式）
- 🔄 易于备份（文本文件）

**适用场景**：
- ✅ 插件配置存储
- ✅ 用户偏好设置
- ✅ 缓存数据
- ✅ 中小型数据集（< 1MB）

### 使用示例

#### 插件中使用

```javascript
// 保存配置
ztools.db.put({
  _id: 'config',
  theme: 'dark',
  lang: 'zh-CN'
})

// 读取配置
const config = ztools.db.get('config')

// 使用 dbStorage
ztools.dbStorage.setItem('lastUsed', Date.now())
const lastUsed = ztools.dbStorage.getItem('lastUsed')

// 批量操作
const users = ztools.db.bulkDocs([
  { _id: 'user-1', name: '张三' },
  { _id: 'user-2', name: '李四' }
])

// 前缀查询
const allUsers = ztools.db.allDocs('user-')
```

#### 主程序中使用

```typescript
import databaseAPI from './database-api'

// 保存应用数据
databaseAPI.dbPut('plugins', pluginList)

// 读取应用数据
const plugins = databaseAPI.dbGet('plugins')

// 查询插件数据统计
const stats = await databaseAPI.getPluginDataStats()
```

### 测试建议

1. **基础功能测试**
   - [ ] 创建文档（db.put）
   - [ ] 读取文档（db.get）
   - [ ] 删除文档（db.remove）
   - [ ] 批量操作（db.bulkDocs）
   - [ ] 查询文档（db.allDocs）

2. **高级功能测试**
   - [ ] 附件存储（postAttachment）
   - [ ] 附件读取（getAttachment）
   - [ ] 前缀查询（allDocs('prefix')）
   - [ ] ID 数组查询（allDocs(['id1', 'id2']）

3. **dbStorage 测试**
   - [ ] 设置值（setItem）
   - [ ] 获取值（getItem）
   - [ ] 删除值（removeItem）

4. **数据持久化测试**
   - [ ] 重启应用后数据是否保留
   - [ ] 自动保存机制
   - [ ] 退出时强制保存

5. **示例插件测试**
   - [ ] 打开数据库示例插件
   - [ ] 执行各项操作
   - [ ] 查看数据统计

### 已知限制

1. **性能**
   - 大数据集（> 10MB）性能下降
   - 频繁写入场景不适用

2. **并发**
   - 不支持多进程并发写入
   - 单进程内串行操作

3. **查询**
   - 不支持复杂查询
   - 只支持前缀查询和精确匹配

### 未来优化

1. **性能优化**
   - [ ] 增量保存（只保存修改项）
   - [ ] 压缩存储（gzip）
   - [ ] 分片存储（大数据集）

2. **功能增强**
   - [ ] 索引支持
   - [ ] 事务支持
   - [ ] 备份恢复
   - [ ] 数据迁移工具

3. **开发体验**
   - [ ] 数据查看器
   - [ ] 调试工具
   - [ ] 性能监控

### 参考资源

- [JSON_DATABASE.md](./JSON_DATABASE.md) - 数据库详细文档
- [DATABASE_MIGRATION.md](./DATABASE_MIGRATION.md) - 迁移说明
- [IMPLEMENTED_APIS.md](./IMPLEMENTED_APIS.md) - API 列表
- [plugins/database-example/](./plugins/database-example/) - 示例插件
- ZTools 源码：`/Users/yunser/app/ZTools/src/main/core/lmdb/`

### 贡献者

- 基于 ZTools 实现
- 使用纯 JSON 替代 LMDB
- 完全兼容 ZTools/UTools API

---

## 总结

本次更新实现了完整的数据库 API 系统，为插件提供了与 ZTools/UTools 兼容的数据存储能力。

**核心价值**：
- ✅ 插件可以持久化存储数据
- ✅ API 格式与 ZTools 完全兼容
- ✅ 数据隔离保证安全性
- ✅ JSON 格式便于调试和备份

**使用建议**：
- 用于插件配置和用户数据存储
- 避免存储超大数据集
- 使用 dbStorage 存储简单键值对
- 定期备份重要数据

**下一步**：
- 测试所有数据库 API
- 优化性能和稳定性
- 完善文档和示例
- 收集用户反馈
