# 数据库迁移说明

本文档记录从 SQLite（better-sqlite3）迁移到纯 JSON 数据库的过程和原因。

## 迁移背景

### 为什么迁移？

1. **参考 ZTools 实现** - ZTools 使用 LMDB 提供类似 UTools 的数据库 API
2. **API 兼容性** - 需要提供与 ZTools/UTools 兼容的数据库 API
3. **简化实现** - 使用纯 JSON 替代 LMDB，降低复杂度
4. **数据可读性** - JSON 格式便于调试、备份和版本控制

### 原有实现的问题

原项目使用 `better-sqlite3`（SQLite 数据库），用于存储：
- 用户信息（users 表）
- 对话列表（conversations 表）
- 消息记录（messages 表）

这套实现主要服务于主程序的聊天功能，**不是插件系统的数据库 API**。

## 新架构设计

### 两套数据存储

现在项目有两套独立的数据存储系统：

#### 1. 主程序数据库（保留 SQLite）

**位置**：`electron/main/database.ts`
**用途**：主程序的聊天功能
**技术栈**：better-sqlite3

```typescript
// 主程序使用
import * as database from './database'

database.initDatabase()
const conversations = database.getConversations()
database.sendMessage(conversationId, senderId, senderType, content)
```

#### 2. 插件数据库 API（新增 JSON Database）

**位置**：`electron/main/json-db/`
**用途**：为插件提供 ZTools 兼容的数据库 API
**技术栈**：纯 JSON 文件

```typescript
// 插件使用
ztools.db.put({ _id: 'config', theme: 'dark' })
const config = ztools.db.get('config')
```

### 文件结构

```
electron/main/
├── database.ts              # 主程序数据库（SQLite）- 保留
├── database-api.ts          # 插件数据库 API（新增）
└── json-db/                 # JSON 数据库实现（新增）
    ├── types.ts            # 类型定义
    ├── index.ts            # 核心实现
    └── jsonDbInstance.ts   # 单例实例
```

## 实现细节

### JSON 数据库

**存储格式**：
```
userData/json-db/
├── main.json         # 主数据库
├── meta.json         # 元数据库  
└── attachments.json  # 附件数据库
```

**特性**：
- ✅ 完全兼容 ZTools/UTools API 格式
- ✅ 支持文档 CRUD 操作（put/get/remove/bulkDocs/allDocs）
- ✅ 支持附件存储（postAttachment/getAttachment）
- ✅ 支持 dbStorage（类似 localStorage）
- ✅ 自动保存机制（默认每秒保存）
- ✅ 命名空间隔离（APP/、PLUGIN/<name>/）
- ✅ 同步和 Promise 两种 API

### API 暴露

**Preload 层**：`electron/preload/plugin-system.ts`

```javascript
// 同步 API
ztools.db.put(doc)
ztools.db.get(id)
ztools.db.remove(docOrId)
ztools.db.bulkDocs(docs)
ztools.db.allDocs(key)
ztools.db.postAttachment(id, attachment, type)
ztools.db.getAttachment(id)
ztools.db.getAttachmentType(id)

// Promise API
await ztools.db.promises.put(doc)
await ztools.db.promises.get(id)
// ...

// dbStorage API
ztools.dbStorage.setItem(key, value)
ztools.dbStorage.getItem(key)
ztools.dbStorage.removeItem(key)
```

## API 统计

### 已实现 API 总数：54 个

新增数据库 API：

1. **数据库操作（8 个）**
   - db.put
   - db.get
   - db.remove
   - db.bulkDocs
   - db.allDocs
   - db.postAttachment
   - db.getAttachment
   - db.getAttachmentType

2. **dbStorage（3 个）**
   - dbStorage.setItem
   - dbStorage.getItem
   - dbStorage.removeItem

## 兼容性说明

### 与 ZTools 的兼容性

| 特性 | ZTools | 本项目 | 说明 |
|------|--------|--------|------|
| API 格式 | ✅ | ✅ | 完全兼容 |
| 文档结构 | ✅ | ✅ | _id, _rev, _lastModified |
| 同步 API | ✅ | ✅ | db.put/get/remove |
| Promise API | ✅ | ✅ | db.promises.* |
| 附件支持 | ✅ | ✅ | postAttachment/getAttachment |
| dbStorage | ✅ | ✅ | 类似 localStorage |
| 存储引擎 | LMDB | JSON | 不同实现，相同接口 |
| 性能 | 极快 | 适中 | JSON 文件 I/O |

### 与原 SQLite 的关系

**独立共存**：
- SQLite 数据库：主程序功能（聊天、用户管理）
- JSON 数据库：插件系统 API

**互不影响**：
- 两套系统完全独立
- 数据存储位置不同
- API 接口不同

## 使用示例

### 插件中使用数据库

```javascript
ztools.onPluginEnter(async () => {
  // 读取插件配置
  const config = ztools.db.get('config')
  
  if (!config) {
    // 首次使用，创建默认配置
    ztools.db.put({
      _id: 'config',
      theme: 'light',
      lang: 'zh-CN'
    })
  }
  
  // 使用 dbStorage 存储简单数据
  ztools.dbStorage.setItem('lastUsed', Date.now())
  
  // 批量操作
  ztools.db.bulkDocs([
    { _id: 'item-1', data: 'hello' },
    { _id: 'item-2', data: 'world' }
  ])
  
  // 前缀查询
  const items = ztools.db.allDocs('item-')
  console.log('找到', items.length, '个项目')
})
```

### 主程序中操作插件数据

```typescript
import databaseAPI from './database-api'

// 读取插件数据统计
const stats = await databaseAPI.getPluginDataStats()

// 读取指定插件的数据
const keys = await databaseAPI.getPluginDocKeys('my-plugin')
const doc = await databaseAPI.getPluginDoc('my-plugin', 'config')

// 清空插件数据
const result = await databaseAPI.clearPluginData('my-plugin')
```

## 示例插件

项目包含一个完整的示例插件：

**位置**：`plugins/database-example/`

**功能**：
- 基础 CRUD 操作演示
- dbStorage 使用示例
- 批量操作演示
- 数据统计展示

**触发关键词**：`db`、`数据库`、`database`

## 数据迁移工具

如果需要从 SQLite 迁移数据到 JSON 数据库，可以使用以下脚本：

```typescript
// 示例：迁移用户配置
import * as database from './database'
import databaseAPI from './database-api'

// 从 SQLite 读取
const users = database.getUsers()

// 转换并保存到 JSON 数据库
for (const user of users) {
  databaseAPI.dbPut(`user-${user.id}`, {
    name: user.name,
    avatar: user.avatar,
    type: user.type
  })
}
```

## 性能考虑

### JSON 数据库性能特点

**优势**：
- ✅ 启动快速（直接加载到内存）
- ✅ 查询快速（内存操作）
- ✅ 数据可读（便于调试）

**劣势**：
- ❌ 保存较慢（需要序列化整个数据集）
- ❌ 大数据集内存占用高
- ❌ 不适合频繁写入场景

### 优化措施

1. **延迟写入** - 使用 isDirty 标记，避免不必要的写入
2. **定时保存** - 默认每秒保存一次，可配置
3. **退出保存** - 应用退出时强制保存
4. **前缀查询优化** - 使用字典序比较
5. **附件 Base64** - 附件使用 Base64 编码存储

### 性能建议

**适用场景**：
- ✅ 插件配置存储
- ✅ 用户偏好设置
- ✅ 缓存数据
- ✅ 中小型数据集（< 1MB）

**不适用场景**：
- ❌ 大量频繁写入
- ❌ 超大数据集（> 10MB）
- ❌ 实时数据同步
- ❌ 并发写入场景

## 未来优化

1. **增量保存** - 只保存修改过的数据
2. **压缩存储** - 可选的 gzip 压缩
3. **分片存储** - 大型数据集分片存储
4. **索引支持** - 添加索引提高查询性能
5. **事务支持** - 原子操作保证数据一致性
6. **备份机制** - 自动备份和恢复

## 参考资源

- [JSON_DATABASE.md](./JSON_DATABASE.md) - 数据库详细文档
- [IMPLEMENTED_APIS.md](./IMPLEMENTED_APIS.md) - API 实现列表
- [plugins/database-example/](./plugins/database-example/) - 示例插件
- ZTools 数据库实现：`/Users/yunser/app/ZTools/src/main/core/lmdb/`
