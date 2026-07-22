# OCR 运行问题说明

本文档记录财务助手（Electron 桌面端）OCR 模型运行时的异常退出问题及排查方式。

相关代码位于：

- `apps/desktop/electron/main/ocr/service.ts`
- `apps/desktop/electron/main/ocr/worker.ts`
- `apps/desktop/electron/main/ocr/engine.ts`

## v6_medium 异常退出

### 现象

切换到 `v6_medium` 后，在设置页调试 OCR 或执行对账时，OCR 子进程可能直接退出，日志类似：

```text
[ocr-worker:35118] [ocr] request start: id=1, type=recognizeText
[ocr] worker process exited: { code: null, signal: 'SIGTRAP' }
```

`SIGTRAP` 通常表示 native 层触发断言或崩溃，普通 JS `try/catch` 捕捉不到。

### 已排除项

对比独立项目 `/Users/yunser/app/paddleocr-nodejs/src/ocr.ts` 后确认：

- `v6_medium` 的模型参数与当前项目一致。
- `PP-OCRv6_medium_det_infer.onnx`、`PP-OCRv6_medium_rec_infer.onnx`、`ppocrv6_dict.txt` 的文件 hash 一致。
- 使用当前项目的 `paddleocr`、`onnxruntime-node` 和同一份模型文件，在系统 Node 下可以正常识别。

因此问题不在模型文件或 PaddleOCR 初始化参数，而是 Electron 运行时中执行 `onnxruntime-node` 的 native 推理时可能触发崩溃。

## 当前处理方式

OCR 已从 `worker_threads` 改为独立子进程执行。这样即使 native ONNX 崩溃，也尽量只退出 OCR 子进程，不带走 Electron 主进程。

OCR 子进程启动时会优先使用系统 Node，而不是 Electron-as-Node。日志类似：

```text
[ocr] starting worker process: {
  execPath: '/Users/yunser/.nvm/versions/node/v24.13.0/bin/node',
  usingElectronAsNode: false
}
```

其中：

- `usingElectronAsNode: false`：正在使用独立系统 Node，推荐状态。
- `usingElectronAsNode: true`：未找到系统 Node，回退到 Electron-as-Node，`v6_medium` 仍可能 `SIGTRAP`。

## Node 查找顺序

OCR 子进程会按以下顺序查找 Node 可执行文件：

1. `OCR_NODE_EXEC_PATH`
2. `NODE_BINARY`
3. `npm_node_execpath`
4. `NVM_BIN/node`
5. `PATH` 中的 `node`
6. `zsh -ic 'command -v node'`
7. 找不到时回退到 Electron-as-Node

## 手动指定系统 Node

如果日志显示 `usingElectronAsNode: true`，可以手动指定：

```bash
OCR_NODE_EXEC_PATH=/Users/yunser/.nvm/versions/node/v24.13.0/bin/node npm run dev
```

如果从仓库根目录启动：

```bash
OCR_NODE_EXEC_PATH=/Users/yunser/.nvm/versions/node/v24.13.0/bin/node pnpm --filter flow-chat dev
```

也可以先确认系统 Node 路径：

```bash
which node
node -v
```

## 相关日志

OCR 运行时会输出以下关键日志：

```text
[ocr] starting worker process: ...
[ocr-worker:12345] [ocr] request start: id=1, type=recognizeText
[ocr-worker:12345] [ocr] recognize input: variant=v6_medium, size=..., data=...
[ocr-worker:12345] [ocr] loading model: variant=v6_medium, preset=PP-OCRv6_medium, dir=...
[ocr-worker:12345] [ocr] model files loaded: variant=v6_medium, det=..., rec=..., dict=...
[ocr-worker:12345] [ocr] model initialized: variant=v6_medium
[ocr-worker:12345] [ocr] recognize finished: variant=v6_medium, boxes=...
```

如果再次出现异常退出，优先看最后一条日志停在哪里：

| 最后一条日志 | 含义 |
|------|------|
| `request start` | 可能在读取输入或加载模型前崩溃 |
| `loading model` / `model files loaded` | 可能在 ONNX session 初始化时崩溃 |
| `model initialized` / `recognize input` | 可能在推理阶段崩溃 |
| `worker process exited` | OCR 子进程退出，查看 `code` / `signal` |

## 对账任务表现

OCR 子进程异常退出后，对账任务应标记为 `failed`，并记录错误信息。主进程不应直接退出。

相关日志：

```text
[finance-check] OCR 开始: ...
[finance-check] OCR 失败: ...
[finance-check] 任务失败: taskId=...
```

## 对照验证

可用独立项目验证同一套模型在系统 Node 下是否正常：

```bash
cd /Users/yunser/app/paddleocr-nodejs
./node_modules/.bin/tsx src/ocr.ts text.png
```

预期输出类似：

```text
你若安好， 便是晴天
```
