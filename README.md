# LabCanvas

LabCanvas 是本机科研实验资料工作台。表格、实验结果图片、图表、日志及原始文件按项目组织。条目可以同时归入多项分类，使用同一份文件或一组关联文件。GUI 和 Agent CLI 共用本机资料库。

## 打开应用

在 macOS 上安装依赖、构建并启动桌面应用。需要 Node.js 22.13 或更新版本，建议使用 Node.js 24。

```sh
npm ci
npm run build
npm run desktop
```

也可双击 `launch-labcanvas.command`。浏览器版通过 `npm start` 启动，访问 `http://127.0.0.1:4317`。开发模式使用 `npm run dev`。服务只监听本机回环地址，应用可离线使用。

首次打开可从左上角新建项目。用 `npm run demo` 手动导入模拟数据。资料库默认位于 `~/.labcanvas`，可通过环境变量 `LABCANVAS_HOME` 指向其他目录。

## 基本操作

- 用左侧项目菜单切换项目。在分类区域新建分类，右键可创建子分类、重命名和删除。父分类显示直接归入其中的条目。
- 点击「添加文件」或把本机文件拖入画布。选中多个文件时，可组成一个条目或分别导入。把文件拖到卡片上可向该条目添加文件。
- 单击卡片选中，双击文件预览打开。拖动卡片改变位置，拖动卡片右缘调宽，拖动空白平移。⌘/Ctrl 加滚轮缩放，右下角的按钮适应全部卡片。
- ⌘/Ctrl 加单击或 Shift 拖框可以多选。在列表中，Shift 加单击选择一个范围。可在详情面板合并选中的条目，或将其中的文件拆成独立条目。
- 将卡片拖到左侧分类，或在详情面板管理分类引用。在分类中按 Delete/退格仅移除当前分类引用，按 Shift 加 Delete/退格移到回收站。回收站支持恢复和确认后永久删除。
- 表格可用上方输入栏或双击单元格编辑，支持 TSV 粘贴、多工作表和修改行列。用「保存」或 ⌘/Ctrl + S 创建版本，版本记录可恢复历史内容。
- PDF、图片和文本有内置查看器，其他文件可下载。图表在外部生成后可与表格一起导入，在组合中查看来源。

表格支持 CSV、TSV 和 XLSX。超过 20,000 行的单个工作表可分页查看。应用保留历史版本，Excel 公式计算和宏由 Excel 处理。单文件上限 200 MB，内置文本编辑上限 2 MB。

## Agent 终端

在工作区运行 `./labcanvas`，或用 `npm link` 安装全局命令。CLI 在 GUI 关闭时也可使用。

```sh
./labcanvas project create AgentFS --slug agentfs
./labcanvas add results.csv plot.svg -p agentfs -c '实验目的/Baseline' -k baseline-001
./labcanvas import ./examples/manifest.json -p agentfs --dry-run
./labcanvas import ./examples/manifest.json -p agentfs
./labcanvas list -p agentfs --json
```

清单、稳定导入标识、JSON 响应、本机 API 和其他命令见 [Agent 接口说明](docs/AGENT_API.md)。

## 备份

```sh
./labcanvas backup /path/to/new-backup-directory
./labcanvas doctor
```

备份包含 SQLite 快照、文件和缩略图。恢复时关闭所有 LabCanvas 进程，使用 `LABCANVAS_HOME` 指向备份目录。资料库升级会另存一份旧结构的 SQLite 快照，后续永久删除会按当前资料库的引用回收文件。

## 验证与打包

```sh
npm run check
npm run test:e2e
npm run test:desktop -- --source
npm run package:mac
npm run test:desktop
```

浏览器测试首次需要 `npx playwright install chromium`。测试使用临时资料库。macOS 打包生成 Apple Silicon 的 `release/LabCanvas-1.0.0-arm64.dmg`，采用本机 ad-hoc 签名。安装包自带运行时。

当前版本的测试范围见 [验收记录](docs/VALIDATION.md)。
