# Windows 运行问题说明

本文档记录 Flow Chat（Electron 桌面端）在 Windows 上常见启动/渲染问题及排查方式。

相关代码位于 `apps/desktop/electron/main/index.ts`。

## 常见现象

### 1. GPU 进程崩溃，应用无法启动

终端日志类似：

```text
GPU process exited unexpectedly: exit_code=-2147483645
GPU process isn't usable. Goodbye.
```

**原因**：显卡驱动异常、虚拟机/远程桌面（RDP）、双显卡切换（Optimus）等环境下，Chromium GPU 子进程启动失败。

**处理**：项目已在 Windows 上默认启用软件渲染策略（见下文「GPU 模式」）。

---

### 2. 应用能启动，但窗口白屏

浏览器访问 `http://127.0.0.1:7777` 正常，Electron 窗口空白。

**原因**：Electron 38+（本项目使用 Electron 42 / Chromium 139+）在 Windows 上，仅调用 `app.disableHardwareAcceleration()` 不足以完全禁用 GPU 呈现。Chromium 仍可能通过 DirectComposition 走 GPU 合成，导致「页面已加载（`did-finish-load` 成功）但屏幕不绘制」。

**处理**：默认 `disable` 模式需同时设置：

- `app.disableHardwareAcceleration()`
- `--disable-gpu`
- `--disable-direct-composition`
- `--disable-gpu-sandbox`

---

### 3. 控制台中文乱码

```text
HTTP 鏈嶅姟鍣ㄨ繍琛屽湪 http://localhost:38765
```

**原因**：Windows 终端默认 GBK，Node.js 输出 UTF-8。

**处理**：启动时会尝试执行 `chcp 65001` 切换为 UTF-8。若仍乱码，不影响功能，可忽略。

---

### 4. SSL 握手失败日志

```text
handshake failed; returned -1, SSL error code 1, net_error -100
```

**原因**：Chromium 后台联网（组件更新、连通性检测等）在部分网络环境下失败。

**处理**：与应用功能无关，可忽略。OCR 接口走本地 `http://localhost:38765`。

---

## GPU 模式

通过环境变量 `ELECTRON_GPU_MODE` 切换，仅在 Windows 生效。

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| `disable`（默认） | 禁用硬件加速 + DirectComposition | 大多数问题机器；白屏/GPU 崩溃 |
| `swiftshader` | ANGLE SwiftShader 软件 GL | `disable` 仍崩溃时尝试 |
| `native` | 不干预，使用系统 GPU | 显卡驱动正常的机器 |

### 使用示例

PowerShell：

```powershell
# 默认
pnpm dev

# GPU 仍崩溃时
$env:ELECTRON_GPU_MODE = "swiftshader"
pnpm dev

# 显卡正常、想启用硬件加速
$env:ELECTRON_GPU_MODE = "native"
pnpm dev
```

CMD：

```cmd
set ELECTRON_GPU_MODE=swiftshader && pnpm dev
```

---

## 开发模式调试

### 启动 dev

```bash
cd apps/desktop
pnpm dev
```

Vite 开发服务器绑定 `127.0.0.1:7777`，避免 Windows 上 `localhost` 的 IPv6 解析问题。

### 查看渲染状态

终端会输出诊断日志：

```text
[main] load target: http://127.0.0.1:7777
[renderer] did-finish-load: http://127.0.0.1:7777/
[renderer] after load: { url: '...', rootLen: 123, bodyLen: 50 }
```

| 字段 | 含义 |
|------|------|
| `rootLen > 0` | React 已挂载，若仍白屏则为 GPU 绘制问题 |
| `rootLen = 0` | React 未渲染，检查 DevTools Console 中的 JS 报错 |

### 打开 DevTools

- 菜单：**View → Toggle Developer Tools**
- 远程调试：Chrome 地址栏输入 `chrome://inspect`，连接 `127.0.0.1:9222`（dev 模式自动开启）

> 不建议在 GPU 异常机器上启动时自动打开 DevTools，可能导致窗口内容区域不可见。

---

## 其他说明

### 移除 CSP

`index.html` 中不再设置严格的 Content-Security-Policy。Vite dev 模式需要 `'unsafe-eval'` 等策略，否则会导致脚本被拦截、界面空白。

### 生产构建

```bash
pnpm --filter flow-chat build
```

生产环境不走 Vite dev server，渲染文件位于 `out/renderer/`。若生产包白屏，优先确认是否正确执行了 `electron-vite build`。

---

## 参考

- [Electron #51363 — disableHardwareAcceleration 在 v38+ 不完全禁用 GPU](https://github.com/electron/electron/issues/51363)
- [Electron #51817 — disableHardwareAcceleration 追加 --disable-gpu](https://github.com/electron/electron/pull/51817)
- [electron-vite — Windows 生产构建白屏（路径问题）](https://github.com/alex8088/electron-vite/issues/460)
