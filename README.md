# 原神配队

发送 `#绫人配队`、`#神鹤万心配队` 或 `#万达配队`。支持用队名、队伍别名和角色别名查询。只有一张图时直接发送，多张图时合并转发。若希望把多张图放在同一条普通消息中，启动时设置 `LOTUS_GUIDES_FORWARD=0`。

将旧 Mora 资源包中已有的 `Genshin/TeamGuides/` 放到宿主的 `data/guides/Genshin/TeamGuides/`，也可在启动时用 `LOTUS_GUIDES_TEAM_DIR` 指定已经存在的目录。沿用其中的 `teamGuides.yaml`、`茗血茶/` 和 `卡玛sei亚/`。

## 来源

- 查询与转发逻辑来自 Rrrrrrray 的 Mora-Plugin 提交 `e75e320de71d3743bfabae77504ce7c0928aca84` 的 `apps/teamGuides.js`、`model/team.js` 与 `model/commonTools.js`。保留 [GPLv3 许可](LICENSE)。[Mora-Plugin](https://gitee.com/Rrrrrrray/mora-plugin)
- 角色别名保留原 Miao `resources/meta-gs/character/alias.js`，角色 ID 与名称取自同目录的 `data.json`。版本为 `2860761836069af80bacee5cb85b6dd2e91ea0b0`。保留 [MIT 许可](LICENSE-MIAO)。[Miao 源码](https://github.com/MOPELotus/miao-plugin/tree/2860761836069af80bacee5cb85b6dd2e91ea0b0)
- 配队索引和图来自旧资源包 `85231a2a1dc2ea0c1c67568a97ac3e144e734b72`，作者为茗血茶和卡玛sei亚。根据原资源仓 README 的来源授权记录，模块从本机已有资源包读取。[配队图来源](https://www.miyoushe.com/ys/collection/1070358)、[阵容图来源](https://www.miyoushe.com/ys/collection/491538)、[Mora 资源库](https://gitee.com/Rrrrrrray/mora-plugin-res)
