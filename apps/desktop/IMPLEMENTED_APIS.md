# 已实现的 ZTools API

本文档记录参考 ZTools 实现的所有简单 API（不依赖复杂原生开发或第三方库）。

## 实现概述

**总计：54 个 API（新增数据库 API）**

## API 分类

### 1. 生命周期事件（3个）
- `onPluginEnter(callback)` - 监听插件进入事件
- `onPluginOut(callback)` - 监听插件退出事件
- `onPluginDetach(callback)` - 监听插件分离事件

### 2. 剪贴板操作（4个）
- `copyText(text)` - 复制文本到剪贴板
- `copyImage(image)` - 复制图片到剪贴板（支持路径、DataURL、Buffer）
- `copyFile(filePath)` - 复制文件到剪贴板（支持单个或多个文件）
- `getCopyedFiles()` - 获取剪贴板中复制的文件列表

### 3. 平台检测（4个）
- `isMacOS()` - 是否为 macOS 平台
- `isWindows()` - 是否为 Windows 平台
- `isLinux()` - 是否为 Linux 平台
- `isDev()` - 是否为开发模式

### 4. 应用信息（5个）
- `getNativeId()` - 获取设备唯一标识符
- `getAppVersion()` - 获取应用版本号
- `getAppName()` - 获取应用名称
- `getPath(name)` - 获取系统路径（home, appData, userData, temp, desktop, documents, downloads, music, pictures, videos）
- `getFileIcon(filePath)` - 获取文件图标（返回 DataURL）

### 5. 窗口控制（4个）
- `showMainWindow()` - 显示主窗口
- `hideMainWindow()` - 隐藏主窗口
- `setExpendHeight(height)` - 设置插件高度
- `outPlugin()` - 退出插件

### 6. 对话框（3个）
- `showNotification(body)` - 显示系统通知
- `showSaveDialog(options)` - 显示保存文件对话框
- `showOpenDialog(options)` - 显示打开文件对话框

### 7. Shell 操作（4个）
- `shellOpenPath(fullPath)` - 使用系统默认方式打开文件或文件夹
- `shellOpenExternal(url)` - 使用系统默认浏览器打开 URL
- `shellBeep()` - 播放系统提示音
- `shellShowItemInFolder(fullPath)` - 在文件管理器中显示文件

### 8. 显示器信息（9个）
- `getPrimaryDisplay()` - 获取主显示器信息
- `getAllDisplays()` - 获取所有显示器信息
- `getCursorScreenPoint()` - 获取鼠标光标的屏幕坐标
- `getDisplayNearestPoint(point)` - 获取最接近指定点的显示器
- `getDisplayMatching(rect)` - 获取与指定区域最匹配的显示器
- `dipToScreenPoint(point)` - DIP 坐标转屏幕物理坐标
- `screenToDipPoint(point)` - 屏幕物理坐标转 DIP 坐标
- `dipToScreenRect(rect)` - DIP 区域转屏幕物理区域
- `screenToDipRect(rect)` - 屏幕物理区域转 DIP 区域

### 9. 系统主题（2个）
- `isDarkColors()` - 是否为深色主题
- `getThemeInfo()` - 获取主题信息

### 10. 子输入框（6个）
- `setSubInput(onChange, placeholder, isFocus)` - 设置子输入框
- `removeSubInput()` - 移除子输入框
- `setSubInputValue(text)` - 设置子输入框的值
- `subInputFocus()` - 聚焦子输入框
- `subInputBlur()` - 子输入框失焦
- `subInputSelect()` - 选中子输入框内容

### 11. 数据库（8个）
- `db.put(doc)` - 创建或更新文档
- `db.get(id)` - 获取文档
- `db.remove(docOrId)` - 删除文档
- `db.bulkDocs(docs)` - 批量操作文档
- `db.allDocs(key)` - 查询文档（支持前缀查询和 ID 数组查询）
- `db.postAttachment(id, attachment, type)` - 存储附件
- `db.getAttachment(id)` - 获取附件
- `db.getAttachmentType(id)` - 获取附件类型

### 12. dbStorage（3个）
- `dbStorage.setItem(key, value)` - 设置键值对（类似 localStorage）
- `dbStorage.getItem(key)` - 获取键值对
- `dbStorage.removeItem(key)` - 删除键值对

## 数据库实现说明

### 存储方式

本项目使用纯 JSON 文件存储替代 ZTools 的 LMDB，具有以下特点：

1. **数据格式** - 可读的 JSON 文本文件
2. **存储位置** - `userData/json-db/` 目录
3. **三个数据库** - main.json（主数据）、meta.json（元数据）、attachments.json（附件）
4. **自动保存** - 默认每秒自动保存一次
5. **命名空间隔离** - 使用前缀机制（APP/、PLUGIN/<name>/）

### API 兼容性

- ✅ 完全兼容 ZTools/UTools 的 API 格式
- ✅ 支持同步 API（`db.put`）和 Promise API（`db.promises.put`）
- ✅ 支持文档版本管理（`_id`、`_rev`、`_lastModified`）
- ✅ 支持附件存储（Base64 编码）
- ✅ 支持前缀查询和批量查询

详细文档：[JSON_DATABASE.md](./JSON_DATABASE.md)

## 暂未实现的复杂 API

以下 API 需要复杂的原生开发或第三方库支持，暂不实现：

### 需要原生开发
- `screenCapture(callback)` - 屏幕截图
- `screenColorPick(callback)` - 屏幕取色
- `simulateKeyboardTap()` - 模拟键盘按键（需要 robotjs）
- `simulateMouseClick()` - 模拟鼠标点击（需要 robotjs）
- `simulateMouseMove()` - 模拟鼠标移动（需要 robotjs）
- `simulateMouseDoubleClick()` - 模拟鼠标双击（需要 robotjs）
- `simulateMouseRightClick()` - 模拟鼠标右键（需要 robotjs）

### 需要第三方库
- `zbrowser.*` / `ubrowser.*` - 浏览器自动化 API（需要 Puppeteer）
- `runFFmpeg()` - FFmpeg 视频处理（需要 FFmpeg）
- `sharp()` - 图像处理（需要 Sharp）

### 需要复杂功能
- `createBrowserWindow()` - 创建独立窗口（需要完整的窗口管理系统）
- `redirect()` - 插件跳转（需要主窗口路由支持）
- `setFeature()` / `getFeatures()` / `removeFeature()` - 动态功能管理
- `onMainPush()` - 主搜索推送（需要搜索系统支持）
- `readCurrentFolderPath()` - 读取 Finder/Explorer 当前路径（需要 AppleScript/Windows API）
- `readCurrentBrowserUrl()` - 读取浏览器当前 URL（需要浏览器扩展或 AppleScript）

## 实现文件

### 主进程实现
- `/electron/main/index.ts` - 所有 IPC 处理器的实现

### Preload 实现
- `/electron/preload/plugin-system.ts` - 插件系统的 API 暴露

## 使用方式

在插件中直接使用 `window.ztools.xxx()` 即可：

```javascript
// 获取平台信息
if (ztools.isMacOS()) {
  console.log('运行在 macOS 上')
}

// 复制文本
ztools.copyText('Hello World')

// 显示通知
ztools.showNotification('操作成功！')

// 获取文件图标
const icon = ztools.getFileIcon('/path/to/file.txt')

// 设置插件高度
ztools.setExpendHeight(400)

// 使用数据库
ztools.db.put({ _id: 'config', theme: 'dark' })
const config = ztools.db.get('config')

// 使用 dbStorage（类似 localStorage）
ztools.dbStorage.setItem('lastUsed', Date.now())
const lastUsed = ztools.dbStorage.getItem('lastUsed')
```

## 参考资源

- ZTools 源码：`/Users/yunser/app/ZTools`
- ZTools Preload：`/Users/yunser/app/ZTools/resources/preload.js`
