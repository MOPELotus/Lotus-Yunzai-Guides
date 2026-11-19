# 原神配队

发送 `#绫人配队`、`#神鹤万心配队` 或 `#万达配队`。支持用队名、队伍别名和角色别名查询。只有一张图时直接发送，多张图时合并转发。若希望把多张图放在同一条普通消息中，启动时设置 `LOTUS_GUIDES_FORWARD=0`。

首次启动会从旧 Mora 使用的 Gitee 仓库下载配队索引与原图。之后每天北京时间 03:00 至 04:00 检查更新，资源保存在宿主的 `data/guides/mora/`。下载失败时，继续使用已有版本。主人也可发送 `#更新摩拉资源`，需要重新拉取当前版本时发送 `#强制更新摩拉资源`。

从旧部署迁移时，可把已有的 `Genshin/TeamGuides/` 放到 `data/guides/Genshin/TeamGuides/`，首次下载完成前会读取这个目录。希望只使用指定目录时，启动前设置 `LOTUS_GUIDES_TEAM_DIR`。如只想暂停自动更新并保留主人更新指令，可设置 `LOTUS_GUIDES_AUTO_UPDATE=0`。

## 来源

- 查询与转发逻辑来自 Rrrrrrray 的 Mora-Plugin 提交 `e75e320de71d3743bfabae77504ce7c0928aca84` 的 `apps/teamGuides.js`、`model/team.js` 与 `model/commonTools.js`，下载来源和更新时段沿用同一提交的 `apps/help.js`。保留 [GPLv3 许可](LICENSE)。[Mora-Plugin](https://gitee.com/Rrrrrrray/mora-plugin)
- 角色别名保留原 Miao `resources/meta-gs/character/alias.js`，角色 ID 与名称取自同目录的 `data.json`。版本为 `2860761836069af80bacee5cb85b6dd2e91ea0b0`。保留 [MIT 许可](LICENSE-MIAO)。[Miao 源码](https://github.com/MOPELotus/miao-plugin/tree/2860761836069af80bacee5cb85b6dd2e91ea0b0)
- 配队索引与原图通过运行时 Git 从 Mora 资源库的 `master` 分支读取。初次迁移对照提交为 `85231a2a1dc2ea0c1c67568a97ac3e144e734b72`。作者为茗血茶和卡玛sei亚。[配队图来源](https://www.miyoushe.com/ys/collection/1070358)、[阵容图来源](https://www.miyoushe.com/ys/collection/491538)、[Mora 资源库](https://gitee.com/Rrrrrrray/mora-plugin-res)
