# JSON 数据库实现

本项目使用纯 JSON 文件存储替代 PouchDB/LMDB，API 格式完全兼容 ZTools/UTools。

## 架构设计

### 文件结构

```
electron/main/json-db/
├── types.ts           # 类型定义
├── index.ts           # 数据库核心实现
└── jsonDbInstance.ts  # 数据库单例
```

### 数据存储

数据存储在 `userData/json-db/` 目录下，采用分片存储策略：

```
json-db/
├── main.json              # 主程序数据
├── attachments.json       # 所有附件（集中存储）
└── plugins/               # 插件数据目录
    ├── plugin-test.json   # 测试插件数据
    ├── my-plugin.json     # 自定义插件数据
    └── ...                # 其他插件数据
```

**优势**：
- ✅ 性能优化 - 只加载需要的插件数据
- ✅ 避免冲突 - 插件数据物理隔离
- ✅ 便于管理 - 可以轻松删除单个插件的数据文件
- ✅ 减少写入冲突 - 不同插件的数据修改不会相互影响

### 数据格式

#### 文件格式

#### main.json（主程序数据）
```json
{
  "docs": {
    "plugins": {
      "_id": "APP/plugins",
      "_rev": "1-1714567890123-abc123",
      "_lastModified": 1714567890123,
      "data": [...]
    },
    "settings": {
      "_id": "APP/settings",
      "_rev": "1-1714567890124-def456",
      "data": {...}
    }
  },
  "meta": {
    "plugins": {
      "_rev": "1-1714567890123-abc123",
      "_lastModified": 1714567890123,
      "_cloudSynced": false
    },
    "settings": {
      "_rev": "1-1714567890124-def456",
      "_lastModified": 1714567890124,
      "_cloudSynced": false
    }
  }
}
```

#### plugins/plugin-test.json（插件数据）
```json
{
  "docs": {
    "config": {
      "_id": "PLUGIN/plugin-test/config",
      "_rev": "1-1714567890125-ghi789",
      "theme": "dark",
      "language": "zh-CN"
    },
    "user-1": {
      "_id": "PLUGIN/plugin-test/user-1",
      "_rev": "1-1714567890126-jkl012",
      "name": "张三",
      "age": 25
    }
  },
  "meta": {
    "config": {
      "_rev": "1-1714567890125-ghi789",
      "_lastModified": 1714567890125
    },
    "user-1": {
      "_rev": "1-1714567890126-jkl012",
      "_lastModified": 1714567890126
    }
  }
}
```

#### 附件格式

```json
{
  "data": "base64-encoded-data",
  "metadata": {
    "type": "image/png",
    "size": 12345,
    "_lastModified": 1714567890123
  }
}
```

## API 说明

### 同步 API

完全兼容 ZTools/UTools 的同步 API：

```javascript
// 创建或更新文档
const result = ztools.db.put({ _id: 'test', data: 'hello' })

// 获取文档
const doc = ztools.db.get('test')

// 删除文档
const result = ztools.db.remove('test')

// 批量操作
const results = ztools.db.bulkDocs([
  { _id: 'doc1', data: 'hello' },
  { _id: 'doc2', data: 'world' }
])

// 查询文档
const docs = ztools.db.allDocs() // 所有文档
const docs = ztools.db.allDocs('PLUGIN/') // 前缀查询
const docs = ztools.db.allDocs(['doc1', 'doc2']) // 指定 ID

// 附件操作
ztools.db.postAttachment('image1', buffer, 'image/png')
const buffer = ztools.db.getAttachment('image1')
const type = ztools.db.getAttachmentType('image1')
```

### Promise API

```javascript
// Promise 形式的 API
const result = await ztools.db.promises.put({ _id: 'test', data: 'hello' })
const doc = await ztools.db.promises.get('test')
const result = await ztools.db.promises.remove('test')
```

### dbStorage API

类似 localStorage 的简化接口：

```javascript
// 设置值
ztools.dbStorage.setItem('key', { foo: 'bar' })

// 获取值
const value = ztools.dbStorage.getItem('key')

// 删除值
ztools.dbStorage.removeItem('key')
```

## 命名空间隔离

### 自动前缀机制

数据库使用前缀机制进行数据隔离：

- `APP/` - 主程序数据 → 存储在 `main.json`
- `PLUGIN/<pluginName>/` - 插件数据 → 存储在 `plugins/<pluginName>.json`
- `ZTOOLS/` - （保留，兼容 ZTools 格式）

### 插件调用示例

插件调用数据库 API 时，会自动添加和移除前缀，插件侧无感知：

```javascript
// 插件中调用（不需要加前缀）
ztools.db.put({ _id: 'config', theme: 'dark' })
// 实际存储：PLUGIN/my-plugin/config
// 存储位置：plugins/my-plugin.json

// 读取数据
const doc = ztools.db.get('config')
// 实际查询：PLUGIN/my-plugin/config
// 返回：{ _id: 'config', theme: 'dark' }（自动移除前缀）
```

### 懒加载机制

为了优化性能，插件数据采用懒加载：

1. 应用启动时只加载 `main.json`（主程序数据）
2. 插件首次访问数据时，才加载对应的 `plugins/<pluginName>.json`
3. 数据修改后，只保存被修改的文件

## 性能特性

### 自动保存机制

- 默认每秒自动保存一次
- 使用 `isDirty` 标记避免不必要的写入
- 应用退出时强制保存

### 内存优化

- 使用 `Map` 数据结构提高查询性能
- 附件使用 Base64 编码存储
- 支持大文件附件（理论无限制）

### 查询优化

- 支持前缀查询（`allDocs('PLUGIN/')`）
- 支持批量 ID 查询（`allDocs(['id1', 'id2'])`）
- 范围查询使用字典序比较

## 与 ZTools 的差异

### 相同点

1. **API 接口完全兼容** - 所有 API 签名与 ZTools 一致
2. **数据格式兼容** - 使用相同的 `_id`、`_rev`、`_lastModified` 字段
3. **命名空间隔离** - 相同的前缀机制
4. **附件支持** - 完整的附件存储和查询

### 差异

1. **存储引擎** - ZTools 使用 LMDB，本项目使用纯 JSON
2. **性能特性**：
   - LMDB: 内存映射，极快的读写速度
   - JSON: 文件 I/O，适中的性能
3. **文件格式**：
   - LMDB: 二进制数据库文件
   - JSON: 可读的 JSON 文本文件（便于调试和备份）
4. **数据迁移**：
   - JSON 文件可以直接编辑和版本控制
   - 更容易进行数据导入导出

## 使用示例

### 插件中使用

```javascript
// 在插件的 HTML/JS 中直接使用
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
  
  // 保存用户数据
  ztools.dbStorage.setItem('lastUsed', Date.now())
})
```

### 主程序中使用

```typescript
// 在主进程中直接操作
import databaseAPI from './database-api'

// 保存应用配置
databaseAPI.dbPut('plugins', pluginList)

// 读取应用配置
const plugins = databaseAPI.dbGet('plugins')
```

## 数据备份与恢复

### 备份

直接复制 `userData/json-db/` 目录：

```bash
cp -r ~/Library/Application\ Support/chat-electron/json-db ~/backup/
```

### 恢复

将备份文件复制回原位置：

```bash
cp -r ~/backup/json-db ~/Library/Application\ Support/chat-electron/
```

### 数据导出

JSON 格式便于导出和分析：

```javascript
// 导出所有数据
const allData = ztools.db.allDocs()
const json = JSON.stringify(allData, null, 2)
// 保存到文件或上传到云端
```

## 最佳实践

### 1. 合理使用命名空间

```javascript
// 推荐：使用清晰的 ID 命名
ztools.db.put({ _id: 'settings', data: {} })
ztools.db.put({ _id: 'cache/user-123', data: {} })

// 不推荐：混乱的命名
ztools.db.put({ _id: '1', data: {} })
```

### 2. 版本管理

```javascript
// 保存版本信息，方便数据迁移
const config = {
  _id: 'config',
  version: 1,
  data: {}
}
```

### 3. 错误处理

```javascript
try {
  const result = ztools.db.put(doc)
  if (!result.ok) {
    console.error('保存失败:', result.message)
  }
} catch (error) {
  console.error('数据库错误:', error)
}
```

### 4. 使用 dbStorage 存储简单数据

```javascript
// 简单数据用 dbStorage
ztools.dbStorage.setItem('lastUsed', Date.now())

// 复杂数据用 db
ztools.db.put({
  _id: 'users',
  data: { /* 复杂对象 */ }
})
```

## 技术细节

### 版本号生成

```typescript
private generateRev(): string {
  return `1-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}
```

格式：`1-时间戳-随机字符串`

### 范围查询实现

```typescript
private getNextPrefix(prefix: string): string {
  const lastChar = prefix[prefix.length - 1]
  const nextChar = String.fromCharCode(lastChar.charCodeAt(0) + 1)
  return prefix.slice(0, -1) + nextChar
}

// 使用字典序比较实现前缀查询
const results = []
for (const [key, value] of this.mainData.entries()) {
  if (key >= prefix && key < this.getNextPrefix(prefix)) {
    results.push(value)
  }
}
```

## 未来优化

1. **增量保存** - 只保存修改过的数据
2. **压缩存储** - 可选的 gzip 压缩
3. **分片存储** - 大型数据集分片存储
4. **索引优化** - 添加索引支持复杂查询
5. **事务支持** - 原子操作保证数据一致性

## 参考资源

- ZTools 数据库实现：`/Users/yunser/app/ZTools/src/main/core/lmdb/`
- ZTools API 文档：`/Users/yunser/app/ZTools/ztools-api-types/`
