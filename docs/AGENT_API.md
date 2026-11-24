# LabCanvas Agent 接口

CLI 直接读写本机 SQLite 资料库。窗口打开时，CLI 导入、归类和修改会自动出现在界面。默认目录为 `~/.labcanvas`。自定义资料库时，桌面端与 CLI 使用相同的 `LABCANVAS_HOME`，或在 CLI 上指定 `--home DIR`。本机服务只监听 `127.0.0.1`。

工作区内可运行 `./labcanvas`，也可执行一次 `npm link` 后在任意目录运行 `labcanvas`。以下命令使用从远程服务器拉到本机的文件。

```sh
labcanvas project create AgentFS --slug agentfs --json
labcanvas projects --json
labcanvas add results.csv plot.svg -p agentfs \
  -c '实验目的/Baseline' -c '模块/缓存' -d 2026-11-20 \
  -t '缓存延迟' -k cache-run-001 --json
labcanvas list -p agentfs -c '实验目的/Baseline' --json
```

`-p` 接受项目 ID、slug 或唯一名称，也可通过 `LABCANVAS_PROJECT` 指定。分类接受 ID 或用 `/` 分隔的路径，添加时会创建缺失的路径。每个分类引用同一条目，父分类显示直接归入其中的条目。为终端脚本显式传入 `--json`，成功时读取 stdout，失败时读取非零退出码及 stderr 中的 `{"error":{"code":"…","message":"…"}}`。

## 单条目和批量导入

`add` 会复制原始文件。多个文件默认组成一个条目，`--separate` 为每个文件创建一个条目。条目内只有一张表格时，应用自动把图片和 PDF 关联到该表格，可以用 `--no-link` 关闭。图表由外部工具生成后与数据表一同导入。

`-k` 是项目内的稳定标识。重复使用同一个标识会更新原条目。同名文件内容有变化时生成新版本，内容相同时沿用旧版本，新文件会追加。带标识的条目应使用不同文件名。省略标识会新建条目。带 `--separate` 导入多个文件时，每个条目的标识由传入的标识和文件名组成。

```sh
labcanvas import ./examples/manifest.json -p agentfs --dry-run --json
labcanvas import ./examples/manifest.json -p agentfs --json
```

[导入清单示例](../examples/manifest.json) 可直接运行。[JSON Schema](import.schema.json) 描述清单结构。

- 顶层 `entries` 包含一个或多个条目，`project` 可选。命令行项目参数优先。
- 每个条目可设定 `key`、`title`、`date`、`note` 和 `collections`。实验日期采用 `YYYY-MM-DD`。
- `files` 接受相对于清单的路径，也接受带 `path`、可选 `name` 和 `source` 的对象。`source` 使用同一条目内的文件名或文件 ID。`link: false` 关闭该条目的自动关联。
- 预检校验文件可读性、大小、分类和来源关系。预检结束后，资料库不保留本次试写的条目或分类。批量提交失败时，所有条目与分类一并回滚。原文件在预览失败时仍可下载。
- 单文件上限 200 MB，每条目每次最多添加 200 个文件。GUI 的一次选择最多 200 个文件。

成功响应中的 `entries[].id` 是条目 ID，`entries[].files[].id` 是文件 ID。文件结果中的 `status` 为 `added`、`unchanged` 或 `updated`，`version` 是文件版本。用 `labcanvas show ENTRY --json` 查询条目完整内容。

## 管理和导出

```sh
labcanvas collections -p agentfs --json
labcanvas classify ENTRY -c '实验日期/2026-11-20' --json
labcanvas unclassify ENTRY -c '实验目的/Baseline' --json
labcanvas attach ENTRY plot.svg --replace --json
labcanvas trash ENTRY --json
labcanvas restore ENTRY --json
labcanvas delete ENTRY --yes --json
labcanvas export FILE_ID -o ./export.csv --json
labcanvas backup /path/to/new-backup-directory --json
labcanvas doctor --json
```

`unclassify` 解除分类引用。回收站保留分类和布局，恢复条目时可继续使用。永久删除会清除条目及其版本引用，仍被其他版本引用的共享文件继续保留。`export` 导出文件当前版本，并保护已存在的目标。完整命令列表见 `labcanvas --help`。

## 本机 HTTP

桌面界面使用同一个服务，默认 `http://127.0.0.1:4317`。桌面端实际地址见资料库内的 `desktop-server.json`。路由均以 `/api` 开头。

| 方法与路径 | 用途 |
|---|---|
| GET `/info`、`/events` | 版本和资料库路径、变更事件 |
| GET/POST `/projects`，PATCH/DELETE `/projects/:p` | 读取和管理项目 |
| GET `/projects/:p/snapshot` | 条目、分类及回收站 |
| POST `/projects/:p/entries` | multipart `files`，可附带 JSON 字符串 `meta`，包含 `mode`、`title`、`collections` 等字段 |
| POST `/projects/:p/collections`，PATCH/DELETE `/collections/:id` | 创建、移动、重命名和删除分类 |
| POST `/projects/:p/memberships` | `{entry_ids,collection_id,member}`，添加或移除引用 |
| POST `/projects/:p/trash`、`/restore`、`/purge`、`/empty-trash` | 回收站操作，按条目操作时传 `{entry_ids}` |
| POST `/projects/:p/merge`，POST `/files/:id/split` | 合并条目或拆出文件 |
| GET/PUT `/projects/:p/layout?view=all` | 读写 `{positions:[{entry_id,x,y,w}],viewport:{x,y,zoom}}` |
| GET/PATCH `/entries/:id`，POST `/entries/:id/files` | 条目详情、元数据修改和添加文件 |
| GET/PATCH `/files/:id/table` | 读取参数 `sheet,offset,limit,version`。写入传 `{expected_version,operations}` |
| GET/PUT `/files/:id/text` | 读取文本，更新传 `{content,expected_version}` |
| GET `/files/:id/raw`、`/thumbnail`、`/versions` | 文件、图片缩略图和版本历史。下载原文件使用 `/raw?download=1&version=N` |
| POST `/files/:id/versions/:number/restore` | 以历史内容创建新版本 |
