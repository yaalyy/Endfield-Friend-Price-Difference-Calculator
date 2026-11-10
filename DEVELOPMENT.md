# 开发者指南

本文面向维护和二次开发本项目的开发者，说明网页结构、计算规则、截图识别流程，以及本地运行与测试方式。所有命令均从仓库根目录执行；Windows 示例使用 PowerShell。

## 1. 项目结构与技术方案

本项目是纯静态网页，入口为 `docs/index.html`。页面通过 CDN 加载 Vue 3 全局构建，使用原生 JavaScript、CSS 和 Vue Options API；没有 `package.json`、npm 安装步骤或前端打包过程。Python 仅用于本地静态服务和自动化测试。

## 2. 本地运行

### 只预览网页

安装 Python 3 后执行：

```powershell
python -m http.server 8765 --bind 127.0.0.1 --directory docs
```

浏览器打开 `http://127.0.0.1:8765/`，停止服务使用 `Ctrl+C`。修改 HTML、CSS 或 JavaScript 后刷新页面即可；资源缓存导致修改未显示时，使用强制刷新。

使用 HTTP 服务进行开发和 OCR 调试，避免直接双击 HTML 时文件协议对 Worker、模型加载及存储行为造成影响。OCR 资源则使用仓库内文件。

### 同时访问网页与测试页面

```powershell
python -I tests/serve.py 8765
```

此服务以仓库根目录为根路径：

| 用途 | 地址 |
| --- | --- |
| 应用 | `http://127.0.0.1:8765/docs/index.html` |
| OCR 单元测试 | `http://127.0.0.1:8765/tests/unit.html` |
| 应用逻辑测试 | `http://127.0.0.1:8765/tests/app.html` |
| 导入界面测试 | `http://127.0.0.1:8765/tests/ui.html` |
| 真实 OCR 测试 | `http://127.0.0.1:8765/tests/e2e.html` |

两种服务示例共用端口 8765，选择一种运行即可。

## 3. 截图导入与 OCR

### 识别流程

```text
选择 / 拖入 / 粘贴图片
  → 校验格式并创建预览
  → 创建识别会话、懒加载 Tesseract
  → 图像缩放、方向处理和倾斜校正
  → 整图识别、名称条定位与单独识别
  → 按坐标将名称、价格、折扣配对
  → 裁剪字段精细识别、补读与合理性检查
  → 生成可编辑预览行
  → 用户确认后更新或新增商品并保存
```

- 支持 JPEG、PNG、WebP；较小图片会在限制内尝试放大。
- OCR 在 Tesseract Worker 中执行，中文与英文文字识别、英文数字识别分别使用两个 Worker。
- `parse.js` 处理全角字符、数字误识别、价格、折扣和名称；无法确定的字段保留为 `null`。
- `pair.js` 根据文字坐标、列范围和主方向配对字段，结合红涨绿跌判断折扣符号；文字与颜色符号冲突时不猜测。
- `recognizer.js` 输出 `[{ name, price, discount }]`，不将内部坐标字段暴露给导入界面。


### 导入校验和合并

`merge.js` 将识别结果转成可编辑行。

名称完全匹配的商品更新折扣；没有完全匹配的名称新增商品，基础价格使用当前默认值。相似名称只给出建议，不会自动覆盖既有商品；

识别价格只用于核对，不直接写入商品数据。预览时，识别价格与按折扣计算的价格相差超过 2 时显示不一致提示；


## 4. 测试环境与执行命令

### 首次配置

```
pip install playwright
playwright install chromium
```


### 自动化测试

```
# 默认运行 unit、app、ui 三个测试页
python tests/run.py

# 只运行指定测试页，可一次指定多个
python tests/run.py unit
python tests/run.py app ui

# 真实 OCR 测试，默认测试集不包含它
python tests/run.py e2e

# 使用本机已安装的 Edge，无需安装 Playwright Chromium
python --browser msedge

# 显示浏览器窗口以便调试
python tests/run.py app --browser msedge --headed

# 测试 JavaScript 覆盖率，生成 coverage/lcov.info
python tests/run.py --browser msedge --coverage
```


| 测试页 | 验证重点 |
| --- | --- |
| `unit` | 数字和符号解析、名称匹配、导入校验、坐标配对、颜色与区域检测 |
| `app` | 实际 Vue 页面中的价格与收益、商品和好友增删改、名称迁移、本地存储 |
| `ui` | 模拟识别结果下的导入交互、编辑、校验、取消与确认流程 |
| `e2e` | Canvas 合成图片上的真实 OCR、取消后重试、字段输出与跨卡片串价检查 |

测试退出码：`0` 表示通过，`1` 表示失败、页面错误或超时，`2` 表示未知测试页、缺少 Playwright 或浏览器启动失败。未捕获异常和大部分控制台错误也会导致失败。

真实 OCR 测试会输出 `SCORE` 和可能的 `MISS`。目前 `MISS` 只报告识别遗漏，不导致运行器失败，因此应同时查看分数与遗漏记录，不能只凭退出码判断识别质量。合成图片的中文字体也会影响结果。

