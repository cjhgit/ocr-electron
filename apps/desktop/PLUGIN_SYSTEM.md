# 插件系统实现总结

## 概述

基于 ZTools 的插件架构，实现了一个简化版的插件系统。支持插件加载、preload 脚本等核心功能。

## 实现的功能

### 1. 第四个 Tab - Apps

在左侧导航栏添加了第四个 tab（立方体图标），用于展示和管理应用插件。

**文件变更：**
- `src/App.tsx` - 添加 apps tab 和路由
- `src/views/AppsView.tsx` - 新建 Apps 视图组件

### 2. 插件列表视图

展示所有已安装的插件，以卡片形式显示：
- 插件图标
- 插件名称
- 插件版本
- 插件描述

### 3. 插件运行视图

点击插件后，进入插件运行界面：
- 顶部导航栏（返回按钮 + 插件信息）
- 插件内容区域（iframe 沙箱）

### 4. 插件加载系统

**后端 API（electron/main/index.ts）：**

1. `POST /api/plugins/list` - 获取插件列表
   - 扫描 `plugins/` 目录
   - 读取每个插件的 `plugin.json`
   - 返回插件列表

2. `POST /api/plugins/load` - 加载插件
   - 读取插件的 `index.html`
   - 读取插件配置中的 preload 路径
   - 返回插件内容和 preload 路径

3. `GET /plugins/:pluginId/:file` - 静态资源服务
   - 提供插件的静态文件（图标、preload 脚本等）
   - 支持多种 MIME 类型

### 5. Preload 脚本支持

支持在插件加载前执行 preload 脚本，用于：
- 注入全局 API
- 提供工具函数
- 扩展插件能力

**实现方式：**
- 在 iframe 的 `<head>` 中先加载 preload 脚本
- preload 脚本通过 `<script src="...">` 标签引入
- 脚本执行完毕后再加载插件主体内容

## 示例插件

### 1. Hello World (`plugins/hello-world/`)

一个简单的示例插件：
- 展示基本的插件结构
- 包含交互按钮
- 简单的状态管理

**文件结构：**
```
hello-world/
├── plugin.json    # 插件配置
├── icon.svg       # 插件图标
└── index.html     # 插件主体
```

### 2. 插件测试 (`plugins/plugin-test/`)

一个用于测试插件功能的工具插件：
- Preload 日志打印
- 前端日志打印
- Window API 测试
- 异步功能测试
- 环境信息测试

**文件结构：**
```
plugin-test/
├── plugin.json         # 插件配置
├── icon.svg           # 插件图标
├── index.html         # 插件主体
└── preload.js         # Preload 脚本
```

**Preload 功能：**
- 注入 `window.ztools` 对象
- 提供插件 API（`copyText`、`onPluginEnter` 等）
- 提供测试方法（`getPluginInfo`、`calculate`、`delay` 等）
- 所有方法调用都会输出日志，方便验证功能
- 不使用闭包，直接定义（更简洁）

## 插件配置格式

```json
{
  "name": "plugin-name",           // 插件唯一标识
  "title": "插件标题",              // 显示名称
  "description": "插件描述",        // 简短描述
  "version": "1.0.0",              // 版本号
  "icon": "icon.svg",              // 图标文件名
  "main": "index.html",            // 入口文件
  "preload": "preload.js"           // preload 脚本（可选）
}
```

## 目录结构

```
chat-electron-260502/
├── src/
│   ├── App.tsx                    # 添加 apps tab
│   └── views/
│       └── AppsView.tsx          # 新建：Apps 视图
├── electron/
│   └── main/
│       └── index.ts              # 添加插件 API
└── plugins/                       # 新建：插件目录
    ├── README.md                 # 插件系统说明
    ├── TESTING.md                # 测试指南
    ├── hello-world/              # 示例插件 1
    │   ├── plugin.json
    │   ├── icon.svg
    │   └── index.html
    └── add-calculator/           # 示例插件 2
        ├── plugin.json
        ├── icon.svg
        ├── index.html
        └── preload/
            └── index.js
```

## 技术实现

### 1. 插件 API 系统

**系统级 Preload (`electron/preload/plugin-system.ts`)**

使用 **TypeScript** 编写，编译后注入到所有插件：
- 提供 `window.ztools` 全局对象
- 实现基础 API（copyText、onPluginEnter 等）
- 类型安全，有完整的类型定义
- 通过 `session.setPreloads()` 自动注入到所有插件
- 插件开发者可以直接使用，无需关心底层实现

**构建流程：**
1. 源文件：`electron/preload/plugin-system.ts`（TypeScript）
2. 编译输出：`out/preload/plugin-system.js`（JavaScript）
3. 注入时机：创建插件 session 时通过 `session.setPreloads()` 注册

**插件级 Preload (`plugin.json` 中配置的 preload)**

可选的，用于插件添加自定义的 Node.js 功能：
- 可以 `require` Node.js 模块（fs、path 等）
- 可以扩展 `window.ztools` 对象（使用 `Object.assign`）
- 只影响当前插件，不影响其他插件
- 可以使用 JavaScript 或 TypeScript（需要自行编译）

**示例：插件测试的 preload.js**
```javascript
// 扩展 ztools，添加自定义测试方法
Object.assign(window.ztools, {
  getPluginInfo: function() {
    return { name: '插件测试', version: '1.0.0' }
  }
})
```

### 2. WebContentsView（参考 ZTools）

使用 Electron 原生的 `WebContentsView`：
- 插件在主进程中通过 WebContentsView 加载
- 每个插件有独立的 session 和 webPreferences
- 支持 preload 脚本配置
- 直接加载本地 HTML 文件（file:// 协议）

```typescript
// 创建 WebContentsView
const pluginView = new WebContentsView({
  webPreferences: {
    preload: preloadPath,          // preload 脚本
    contextIsolation: false,
    nodeIntegration: false,
    webSecurity: false,
    sandbox: false,
    session: pluginSession          // 独立 session
  }
})

// 添加到主窗口
win.contentView.addChildView(pluginView)

// 加载插件 HTML
const pluginUrl = pathToFileURL(mainFile).href
pluginView.webContents.loadURL(pluginUrl)
```

### 2. IPC 通信

通过 IPC 实现渲染进程和主进程通信：

```typescript
// 渲染进程
window.pluginAPI.open({
  id: plugin.id,
  path: plugin.path,
  config: { main: 'index.html', preload: 'preload.js' }
})

// 主进程
ipcMain.handle('plugin:open', async (_, pluginData) => {
  // 创建并加载插件
})
```

### 3. 插件隔离

- 每个插件运行在独立的 WebContentsView 中
- 独立的 session（`persist:plugin-${id}`）
- 独立的 preload 环境
- 与主窗口和其他插件完全隔离

## 与 ZTools 的对比

### 已实现的功能

✅ 插件列表展示  
✅ 插件加载  
✅ Preload 脚本支持  
✅ 插件配置文件（plugin.json）  
✅ 插件图标  
✅ WebContentsView 隔离（与 ZTools 一致）  
✅ 独立 session 管理  
✅ 从任意路径加载插件  

### 未实现的功能

❌ 更多 ZTools API（窗口控制、文件操作等）  
❌ 完整的插件生命周期（PluginOut、PluginDetach 等）  
❌ 插件通信机制  
❌ 插件市场  
❌ 插件权限管理  
❌ 插件开发模式  
❌ 热重载  
❌ 动态调整插件视图大小  

## 已实现的插件 API

### API 实现架构

**系统 Preload（TypeScript）：**
- 源文件：`electron/preload/plugin-system.ts`
- 编译输出：`out/preload/plugin-system.js`
- 通过 `session.setPreloads()` 注入到所有插件
- 提供类型安全的基础 API

**对比 ZTools：**
- ZTools 的插件 preload：`resources/preload.js`（纯 JavaScript，1600+ 行）
- 我们的系统 preload：`electron/preload/plugin-system.ts`（TypeScript，带类型定义）
- 两者都通过 `session.setPreloads()` 注入，实现方式相同

### 1. copyText(text: string): boolean

复制文本到系统剪贴板。

**使用方式：**
```javascript
// 在插件的 preload 脚本中注入
window.ztools.copyText('要复制的文本')
```

**实现位置：**
- 主进程：`electron/main/index.ts` - `plugin:copy-text` IPC 处理器
- Preload：插件的 `preload.js` - 暴露为 `window.ztools.copyText`

**参考实现：**
- ZTools: `/Users/yunser/app/ZTools/src/main/api/plugin/clipboard.ts`
- ZTools Preload: `/Users/yunser/app/ZTools/resources/preload.js`

### 2. onPluginEnter(callback: Function): void

监听插件进入事件，当插件被加载时触发回调。

**使用方式：**
```javascript
// 在插件代码中注册监听
window.ztools.onPluginEnter((action) => {
  console.log('插件进入事件:', action)
  console.log('类型:', action.type)
  console.log('数据:', action.payload)
})
```

**事件参数：**
```typescript
{
  type: string,      // 进入类型（default, command, etc.）
  payload: {         // 附加数据
    pluginId: string,
    pluginPath: string,
    loadTime: string
  }
}
```

**实现位置：**
- 主进程：`electron/main/index.ts` 
  - `plugin:onPluginEnter` IPC 处理器：获取进入参数
  - `plugin:open` 中发送 `plugin-enter` 事件
- Preload：插件的 `preload.js` 
  - 监听 `plugin-enter` IPC 事件
  - 暴露为 `window.ztools.onPluginEnter`

**参考实现：**
- ZTools: `/Users/yunser/app/ZTools/src/main/api/plugin/lifecycle.ts`
- ZTools Preload: `/Users/yunser/app/ZTools/resources/preload.js`

## 测试插件 API

在"插件测试"插件中提供了完整的测试用例：

1. **复制文本测试**：点击"复制测试文本"按钮，然后使用 Cmd+V 或 Ctrl+V 粘贴验证
2. **插件进入事件测试**：点击"监听进入事件"按钮注册监听，查看日志输出  

## 使用方式

1. **查看插件列表**
   - 点击左侧第四个 tab（立方体图标）
   - 查看已安装的插件

2. **运行插件**
   - 点击插件卡片
   - 插件在 iframe 中加载并运行

3. **返回列表**
   - 点击顶部返回按钮

## 开发新插件

1. 在 `plugins/` 目录下创建新文件夹
2. 创建 `plugin.json` 配置文件
3. 创建 `icon.svg` 图标
4. 创建 `index.html` 入口文件
5. （可选）创建 `preload/index.js` 脚本

详见：`plugins/README.md`

## 测试

详见：`plugins/TESTING.md`

## 后续扩展建议

1. **实现更多 ZTools API**
   - 参考 ZTools 的 API 设计
   - 通过 preload 注入更多系统能力

2. **插件开发工具**
   - 插件脚手架
   - 调试模式
   - 热重载

3. **插件管理**
   - 插件安装/卸载
   - 插件更新检查
   - 插件市场

4. **安全增强**
   - 插件权限系统
   - 代码签名验证
   - 沙箱权限控制
