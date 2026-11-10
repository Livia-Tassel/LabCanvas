# LabCanvas v1.0 · Agent 接口

本机单用户应用。CLI 无需启动 GUI，直接使用同一份 SQLite 数据库；HTTP API 随应用启动，默认 `http://127.0.0.1:4317/api`。只绑定本机回环地址。数据目录默认 `~/.labcanvas`；CLI 使用 `--home` 或 `LABCANVAS_HOME` 切换，GUI/服务使用 `LABCANVAS_HOME`。桌面端端口被其他应用占用时使用空闲端口，实际地址见资料库内 `desktop-server.json`。

## 发现项目与数据

```sh
labcanvas projects list
labcanvas collections list --project agentfs-demo
labcanvas items list --project agentfs-demo --query 缓存
labcanvas items get --id itm_...
labcanvas groups list --project agentfs-demo
labcanvas runs list --project agentfs-demo
```

CLI 始终输出 JSON。成功退出码为 0；失败非零，stderr 为 `{"error":{"code":"...","message":"...","details":...}}`。不要解析中文提示来判断结果，使用 error.code。`--json` 可显式传入，但不是必需。

项目可用永久 ID 或 slug 指定；其他资源使用永久 ID。分类支持 ID 或 `/` 分隔的路径，路径在导入和添加分类时自动创建。文件名和条目名称可重复，不能作为身份。

## 直接导入

```sh
labcanvas projects create --name AgentFS --slug agentfs
labcanvas import ./results.csv ./plot.png --project agentfs --collection '模块测试/缓存' --collection '日期/2026-11-10' --key cache-run-001
labcanvas import ./run.log --project agentfs --role supporting --run run_...
labcanvas import ./plot.png --project agentfs --source itm_...
```

文件会复制进资料库，之后原始路径可以移动。只有相同字节的存储对象会共享，条目身份仍独立。省略 `--key` 会为每次调用生成新导入标识；需要安全重试时务必显式指定。

## 清单导入

```sh
labcanvas import --project agentfs --manifest ./examples/manifest.json --dry-run
labcanvas import --project agentfs --manifest ./examples/manifest.json
```

完整示例见 `examples/manifest.json`。JSON Schema 来自运行时同一份验证器：`GET /api/schema/import`；仓库副本为 `docs/import.schema.json`。

- `version`: 固定为 1，可省略。
- `import_key`: 在项目内唯一的本次导入标识。相同清单和内容重试返回原始结果，`replayed: true`。相同标识、不同清单或字节返回 `IDEMPOTENCY_CONFLICT`；修改内容应换新标识或提交条目新版本。幂等检查要求源文件仍可读取，源文件已删时可使用返回的永久 ID 查询原结果。
- `items[]`: 本次新建的独立资料。至少 1 个，最多 200 个。每项 `key` 是本清单内的临时标识；`path` 相对于清单所在目录；`filename` 可覆盖展示的原始文件名；`title` 可选；`role` 为 `result` 或 `supporting`；`description`、`metadata`、`occurred_at` 可选。
- `collections[]`: 分类永久 ID 或路径。只加入引用，不复制资料。
- `derived_from[]`: 本清单的条目 key 或已存在的条目 ID。记录来源当时的版本；禁止跨项目、引用回收站条目以及来源循环。
- `groups[]`: 可选结果组合。`key`、`title`、`members` 必填；至少两份不同的结果资料；成员可为本清单 key 或已有条目 ID。`primary` 指定主预览；`collections` 指定组合分类。
- `run`: 可选 `{title, occurred_at, command}`，关联所有本批条目。也可以使用 `{id: "run_..."}` 关联已有运行。含辅助资料但省略 run 时自动创建导入记录。时间接受带时区的 ISO 8601，统一存成 UTC。

所有条目与组合的 key 在同一清单内不可重复。预检检查整个批次；失败不创建条目、分类、组合或运行。`--dry-run` 不复制文件。成功导入的元数据在同一个 SQLite 事务中提交；预览失败不会撤销已保存的文件，会以 `preview_status: "failed"` 和 warning 返回。底层拷贝发生故障时可重试同一导入标识，不会产生部分资料条目。

单文件最大 100 MB，每批最多 500 MB。GUI 与 CLI 使用相同限制。

成功返回：

```json
{
  "project_id": "prj_...",
  "import_key": "cache-run-001",
  "replayed": false,
  "items": [{"key":"table","id":"itm_...","status":"created","version":1,"preview_status":"ready"}],
  "groups": [{"key":"comparison","id":"grp_...","status":"created"}],
  "run_id": "run_..."
}
```

## 更新、分类与组合

```sh
labcanvas membership add --project agentfs --id itm_... --collection 'Baseline'
labcanvas membership remove --project agentfs --id itm_... --collection 'Baseline'
labcanvas groups create --project agentfs --name '延迟对比' --members itm_a,itm_b --primary itm_b
labcanvas groups update --project agentfs --id grp_... --primary itm_a
labcanvas groups remove --project agentfs --id grp_... --member itm_b
labcanvas groups dissolve --project agentfs --id grp_...
labcanvas sources set --id itm_figure --source itm_table
labcanvas items update --id itm_... --name '新的名称' --description '实验条件'
labcanvas versions list --id itm_...
labcanvas versions add --id itm_... --file ./new-results.csv --expected-version 1
labcanvas versions restore --id itm_... --version 1 --expected-version 2
```

组合分类会被其成员继承，条目详情中的 `collectionIds` 是有效分类，`directCollectionIds` 是直接分类。移除继承的分类需要操作对应组合。解散组合和移出成员都保留文件，并将组合分类保留给成员；两成员组合移出一项时解散组合。更改主预览仅影响展示。

更新文件和单元格必须提交 `expected_version`，避免静默覆盖。恢复历史内容也会新建版本，不改写历史。来源文件更新后，派生资料的 `sources[].stale` 为 true；更新来源关系需显式执行 `sources set`。同一条目可以由多份资料生成。

```sh
labcanvas items trash --project agentfs --id itm_... --id itm_...
labcanvas items restore --project agentfs --id itm_...
labcanvas items list --project agentfs --trash
labcanvas items export --id itm_... --output ./export.csv
```

回收站隐藏所有引用，并保留分类、组合成员关系、布局与版本。恢复时一并恢复。v1 不提供永久清空回收站。删除分类及子分类不会删除资料。

## HTTP 路由

所有请求/响应默认 JSON；错误形状与 CLI 相同，HTTP 400/404/409/413/422 表示输入、资源缺失、冲突、大小限制、预检失败。GUI 自动轮询资料库，因此 CLI 离线导入在 GUI 中通常 4 秒内可见。

| 方法 | 路径（均以 /api 开头） | 输入 / 用途 |
|---|---|---|
| GET | /、/health、/info、/help、/schema/import | 发现、健康、数据目录、本文、清单 Schema |
| GET / POST | /projects | 查询 / 创建 `{name,slug?,description?}` |
| PATCH | /projects/:p | 更新 `{name?,description?}` |
| GET | /projects/:p/snapshot | 项目全部条目、回收站、分类、组合、运行 |
| GET / POST | /projects/:p/collections | 查询 / 创建 `{name,parent_id?}` |
| PATCH / DELETE | /projects/:p/collections/:id | 重命名 `{name}` / 删除分类树 |
| PUT / DELETE | /projects/:p/memberships | 添加 / 移除 `{target_id,collection_id}`，target 为条目或组合 |
| GET | /projects/:p/items | 参数 `q,role,collection,trash=true`；返回单个资料粒度 |
| GET / PATCH | /items/:id | 详情 / `{title?,description?,role?,occurred_at?}` |
| PUT | /items/:id/sources | `{sources:["itm_..."]}` |
| POST | /projects/:p/trash、/projects/:p/restore | `{ids:["itm_..."]}` |
| GET / POST | /projects/:p/groups | 查询 / 创建 `{title,members,primary?,collections?}` |
| PATCH / DELETE | /projects/:p/groups/:id | `{title?,primary?}` / 解散组合 |
| DELETE | /projects/:p/groups/:id/members/:item | 从组合移出，保留资料 |
| GET | /projects/:p/runs | 按实验时间倒序的运行记录 |
| POST | /projects/:p/import | 原始清单，或 `{manifest,base_dir}`；`?dry_run=true` 预检；路径相对于服务进程或 base_dir |
| POST | /projects/:p/uploads | multipart：多个 files，roles JSON 数组，collections JSON 数组，可选 run JSON 和 import_key |
| POST | /projects/:p/tables | `{name,rows?,columns?,collections?}` 新建 CSV |
| GET | /items/:id/table | `sheet=0,offset=0,limit=100,col_offset=0,col_limit=60`，全部零基；最大每页 200 行 / 100 列 |
| PATCH | /items/:id/table | `{expected_version,changes:[{sheet:0,row:1,column:1,value:"3.4"}]}`，零基坐标 |
| GET / PATCH | /items/:id/text | `{content,truncated,version}` / `{content,expected_version}`，编辑最多 2 MB |
| GET | /items/:id/versions | 历史版本列表 |
| POST | /items/:id/versions/:version/restore | `{expected_version}` |
| GET | /items/:id/file | 当前原文件；`?download=1` 下载；`?version=N` 获取历史原文件 |
| GET | /items/:id/preview | 图片 PNG 缩略图 |
| GET / PUT | /projects/:p/layout?view=all | 读取 / 保存 `{positions:[{target_id,x,y,width}],viewport:{x,y,zoom}}` |

画布 view 为 `all`、`recent` 或 `collection:col_...`。各视图坐标与缩放独立保存。GUI 中分类仅显示直接加入的条目和组合，组合成员折叠显示；上级分类不隐式聚合子分类。CLI items 列表包含组合继承分类的成员。

HTTP 示例：

```sh
curl --noproxy '*' http://127.0.0.1:4317/api/projects
curl --noproxy '*' -X POST http://127.0.0.1:4317/api/projects/agentfs/uploads \
  -F 'files=@./results.csv' -F 'roles=["result"]' -F 'collections=["Baseline"]'
```

## 备份与校验

```sh
labcanvas backup --output /path/to/new-backup-directory
labcanvas doctor
```

备份使用 SQLite 在线备份并复制不可变对象。恢复时关闭所有 LabCanvas 进程，将备份目录用作 `LABCANVAS_HOME`，或复制为原资料库目录。doctor 校验数据库与原文件是否存在。v1 不提供跨设备同步或多人并发编辑。
