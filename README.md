# 攻略

## 角色攻略

`#钟离攻略`、`*流萤攻略` 和 `%艾莲一图流` 分别查询原神、星铁和绝区零的角色攻略。也可以用角色别名或 `#星铁`、`#绝区零` 前缀。用 `#更新钟离攻略`、`*更新流萤攻略` 或 `%更新艾莲一图流` 重新检查原资源仓和作者合集，无需等合集列表的两分钟缓存过期。更新失败时会尝试使用本机已有原图。

宿主就绪后在后台从原 Gitee 资源仓准备三款游戏的角色攻略和进阶参考。每天北京时间 03:00 至 04:00 检查更新，已有文件按 Git 内容哈希复用，只下载缺少或变化的原图。断线后保留已下载的文件及正在使用的版本，恢复后继续下载。准备期间也可查询，已有原图直接发送，缺少的角色可按需从原源读取。米游社攻略沿用原作者合集，按角色读取及刷新。

自动同步的角色和进阶原图保存在 `data/guides/role-origin/`。按角色缓存和自定义图默认放在 `data/guides/roleGuides/`，可用 `LOTUS_GUIDES_ROLE_DIR` 改路径。自定义图放在 `add_ons/<作者>/<角色>.<扩展名>`，星铁和绝区零在作者目录下分别多一层 `StarRail/` 和 `ZenlessZoneZero/`。同一作者的自定义图优先。

要沿用原有合集配置，将 `roleGuides.yaml`、`srRoleGuides.yaml` 和 `zzzRoleGuides.yaml` 放进 `config/guides/`。也可用 `LOTUS_GUIDES_ROLE_CONFIG_DIR` 指定旧插件的配置目录。旧 `temp/strategy/` 与 `data/strategy/` 中的原神图可以继续读。旧 Atlas 目录可用 `LOTUS_GUIDES_LEGACY_ATLAS_DIR` 指定。原资源包默认依次从 `data/guides/mora-plugin-res/` 和旧部署的 `plugins/mora-plugin/resources/mora-plugin-res/` 读取，可用 `LOTUS_GUIDES_MORA_PACK_DIR` 指定自己的副本。

`#钟离进阶参考`、`#钟离收益曲线` 和 `*罗刹参考面板` 会一起读旧资源库的图和作者说明。原神用 `#收益曲线帮助`，星铁用 `*参考面板帮助`。

## 原神配队

发送 `#绫人配队`、`#神鹤万心配队` 或 `#万达配队`。支持用队名、队伍别名和角色别名查询。只有一张图时直接发送，多张图时合并转发。若希望把多张图放在同一条普通消息中，启动时设置 `LOTUS_GUIDES_FORWARD=0`。

首次启动会从原 Gitee 仓库下载配队索引与原图。之后每天北京时间 03:00 至 04:00 检查更新，资源保存在宿主的 `data/guides/mora/`。下载失败时，继续使用已有版本。主人也可发送 `#更新配队资源`，需要重新拉取当前版本时发送 `#强制更新配队资源`。

从旧部署迁移时，可把已有的 `Genshin/TeamGuides/` 放到 `data/guides/Genshin/TeamGuides/`，首次下载完成前也会尝试读取旧资源包。希望配队只使用指定目录时，启动前设置 `LOTUS_GUIDES_TEAM_DIR`。如需暂停角色、进阶和配队的后台同步，可设置 `LOTUS_GUIDES_AUTO_UPDATE=0`。手动更新仍可用。

## 活动日历

原神用 `#日历` 和 `#日历列表`，读取公开游戏公告和活动公告，显示祈愿、集录、纪行和活动。已有原日历资源时，也会显示角色生日和当天开放的天赋材料，按北京时间 04:00 切换。原神资源可由 `LOTUS_GENSHIN_GACHA_THEME_DIR` 指定，默认读取 `data/genshin/miao-theme/`。

`*日历` 或 `#星铁日历` 查看北京时间今天前后各六天。用 `*日历列表` 或 `#星铁日历列表` 查看同一批活动的列表。数据取自国服公开公告，公告中的活动时间优先。挑战仅在公告提供确切时段时显示。

绝区零用 `%日历`、`#绝区零日历`，列表用 `%日历列表`、`#绝区零日历列表`。限时频段和活动图取自原国服公告。绝区零沿用旧日历的水元素底图，默认读取 `data/genshin/miao-theme/` 的原公用资源，也可单独设置 `LOTUS_ZZZ_CALENDAR_THEME_DIR`。

星铁可用 `LOTUS_STAR_RAIL_GACHA_THEME_DIR` 指定原日历的 `resources/`，默认读取 `data/starrail/miao-theme/`。活动图读取公告原地址，渲染用本机物理 GPU。

## 来源

- 查询与转发逻辑来自 Rrrrrrray 的 Mora-Plugin 提交 `e75e320de71d3743bfabae77504ce7c0928aca84` 的 `apps/teamGuides.js`、`model/team.js` 与 `model/commonTools.js`，下载来源和更新时段沿用同一提交的 `apps/help.js`。保留 [GPLv3 许可](LICENSE)。[Mora-Plugin](https://gitee.com/Rrrrrrray/mora-plugin)
- 角色别名保留原 Miao `resources/meta-gs/character/alias.js`，角色 ID 与名称取自同目录的 `data.json`。版本为 `2860761836069af80bacee5cb85b6dd2e91ea0b0`。保留 [MIT 许可](LICENSE-MIAO)。[Miao 源码](https://github.com/MOPELotus/miao-plugin/tree/2860761836069af80bacee5cb85b6dd2e91ea0b0)
- 配队索引与原图通过运行时 Git 从 Mora 资源库的 `master` 分支读取。初次迁移对照提交为 `85231a2a1dc2ea0c1c67568a97ac3e144e734b72`。作者为茗血茶和卡玛sei亚。[配队图来源](https://www.miyoushe.com/ys/collection/1070358)、[阵容图来源](https://www.miyoushe.com/ys/collection/491538)、[Mora 资源库](https://gitee.com/Rrrrrrray/mora-plugin-res)
- 角色攻略沿用 Rrrrrrray 的 Mora-Plugin 同一版本的 `apps/roleGuides.js`、`model/roleGuide.js` 与三个默认攻略配置，按原作者从 Mora 资源库和米游社合集读取图片。星铁角色别名及 ID/名称来自 Miao 同一提交里的 `resources/meta-sr/character/`。[Mora-Plugin](https://gitee.com/Rrrrrrray/mora-plugin)、[Mora 资源库](https://gitee.com/Rrrrrrray/mora-plugin-res)
- 三款游戏的活动日历依据同一 Miao 提交里的 `apps/wiki/Calendar.js`、`CalendarSr.js`、`CalendarZZZ.js` 及 `resources/wiki/calendar.html`、`calendar.css`。原神材料轮换沿用 `resources/meta-gs/material/daily.js`。[喵喵日历源文件](https://github.com/MOPELotus/miao-plugin/tree/2860761836069af80bacee5cb85b6dd2e91ea0b0/apps/wiki)
