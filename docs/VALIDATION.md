# LabCanvas 1.0 验收记录

验证日期：2026-11-10。环境：macOS Apple Silicon；开发 Node 25.9，安装包内置 Node 24.15 / Electron 40。

## 自动化结果

- `npm run build`：TypeScript 检查与生产构建通过。
- `npm test`：16 项数据层 / HTTP 测试通过。
- `npm run test:e2e`：9 项真实浏览器流程通过。
- `npm run test:desktop`：对实际打包的 macOS 应用复验通过，详见 [结构化报告](desktop-verification.json)。
- 安装包使用 ad-hoc 签名；`codesign --verify --deep --strict` 通过；DMG 使用 `hdiutil verify` 检查。

全部测试使用临时资料库和明确标注的模拟数据，不接触真实实验资料。

## 需求对应证据

| 需求 | 实现与验证 |
|---|---|
| 按项目独立组织 | GUI 创建/切换项目；数据层测试阻止跨项目分类、组合、来源和布局引用 |
| 同一条目属于多个分类 | memberships / group_collections 引用独立条目；移除分类、删除分类保留文件测试 |
| 删除条目从所有视图消失 | 回收站统一过滤；恢复测试验证分类、组合和坐标保留 |
| 单个表格/图片为粒度，可合并组合 | 独立 ID、组合成员与主预览；GUI 导入后建组、展开、解散与恢复测试 |
| 日志默认不展示，按时间集中管理 | result / supporting 用途；运行记录按实验时间展示；GUI 日志隐藏测试 |
| 真实内容缩略图 | CSV/XLSX 真实单元格预览、图片 PNG 缩略图；浏览器与安装包验证图像成功加载 |
| 无界画布与布局 | 平移、缩放、拖动、缩放适应、多选、调整宽度；位置和每个视图缩放的重启持久化测试 |
| 完整表格查看和必要编辑 | 多工作表与行列分页；单元格、TSV 粘贴、增行增列；CSV/XLSX 保存与原版本保留测试 |
| 图片、文本、PDF 与一般文件 | 图片查看；日志/文本保存；PDF 画布实际像素渲染断言；原文件下载往返测试 |
| GUI 操作简洁 | 实际截图见 screenshot-desktop.png、screenshot-list.png、screenshot-table.png、screenshot-runs.png |
| Agent 终端导入 | 离线 CLI 与 GUI 同库；清单、Schema、预检、幂等、错误 JSON；并发 CLI 与界面同步测试 |
| 来源可追溯 | 图到表的来源、使用版本和更新提示；循环引用禁止、源版本变化和历史恢复测试 |
| 可直接使用的 v1.0 | 自带运行时的签名 macOS 应用及 DMG；安装包启动、菜单、编辑、关闭保护、PDF 实际复验 |

## 产品边界

本机单用户版本。表格提供单元格值编辑，保留历史和公式，不在应用内执行 Excel 公式计算或宏。复杂 Excel 功能不承诺完整兼容。单文件最多 100 MB，每批最多 500 MB。没有云同步、论文管理、后台实验调度或永久清空回收站。
