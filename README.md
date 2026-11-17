# 揽京灵感工作台（dsh-media-desk-lanjing）

> 这是 [dsh-media-desk（自媒体工作台）](https://github.com/woniuniuniu/dsh-media-desk) 的**分叉（fork）**，在原有「一句话记灵感，一键成稿」之上，新增了面向北京房产写作的**每日「灵感源」**。
>
> 上游作者：**蜗牛的科技笔记**（MIT 许可）。原 README 见 [README.upstream.md](README.upstream.md)，署名与许可见 [LICENSE](LICENSE)。

## 安装到另一台 DeepSeek Harness

把本插件装进另一台 DSH，两种方式任选：

**方式一：从源码目录一键装（推荐，也能 fork/PR 优化）**

1. `git clone https://github.com/Chang-Tong/dsh-media-desk-lanjing.git`
2. `cd dsh-media-desk-lanjing && npm install && npm run build`（生成 `dist/`）
3. 在 DSH 打开 **插件** → **添加插件**，指向该目录；或直接对一个会话说「把 `/…/dsh-media-desk-lanjing` 这个目录作为插件装进来」。装好后同一 Profile 的会话共享该插件。

**方式二：npm 安装包**

把 `npm pack` 打出的 `dsh-media-desk-lanjing-*.tgz` 在插件管理里安装（装一次即可，无需 clone/build）。

**装好之后**：侧栏会出现「灵感工作台」。它的核心「灵感源」与「一键成稿」开箱即用。

### 可选的私有数据源（没有也能用，只是少几块数据能力）

- **`lanjing-data` MCP**（网签/项目/土地等只读数据）：这是作者本机的私有后端，**不会打进仓库**。换机器用需要自己配一个同样的 `lanjing-data` MCP 条目，并把 sidecar 放到 `~/.dsh/media-desk-lanjing/data-mcp.json`。没配置时，涉及取数的频道如实报「未配置/不可用」，不会编造数据库结论。
- **埋点转化**（`buy-points`）：默认读本地快照即可；要实时数据才需要数据仓的 `scripts/conversion-funnel.js`，可通过环境变量 `LANJING_CONVERSION_SCRIPT=/绝对/路径/conversion-funnel.js` 指定，或放到默认检出位置。缺脚本时如实降级，绝不用 0 冒充。

## 今日选题、小红书草稿与栏目排期

- 「灵感源」顶部可选综合、网签、新盘动态、市场动态、土拍与政策、社区热议或具体频道。北京时间每天从近 7 天素材推荐最多 5 个候选，标出来源和收集日期；不足 5 个时不补假选题。
- 「选这个题」创建独立选题、保留原文快照并打开创作，默认小红书归藏 3:4 图文。生成后可以编辑、按当前文案重排。
- 「飞书选题 → 创作 → 电脑草稿」显示飞书回复状态、当前选题和失败原因，也可从已有选题发起一次讨论。每日北京时间 10:00 的五题推送沿用 Codex 本机自动化，讨论确认后才进入生成。
- 回复桥随 Air 上的 DSH 工作台 Host 运行，与 Superagent 的运行状态无关。每次电脑操作都须单独确认 Air / GPT-6.1 Terra / 当前稿件，只保存小红书本地草稿并回读验证；公开发布由本人完成。旧的无人确认自动草稿入口停用。
- 退出 DSH 或电脑离线时回复等待下次启动处理；本版不能作为服务器全天候运行的验收。专业技能自动编排、视频成片及执行回执按实际已完成阶段显示，不用生成状态代替事实与草稿验收。完整流程见 [创作工作流](docs/editorial-workflow.md)。
- 埋点默认只读取本地快照；首次打开工作台、进入埋点页和切换窗口都不调用腾讯云。需要最新数据时手动点「读取埋点数据」或「重新取数」。

栏目依据：[北京房产博主选题与栏目试排](docs/研究-北京房产博主选题与栏目试排-20261113.md)。

## 0.2：从素材到创作

「灵感源」现在是素材池，默认显示全部新闻。新闻被安排过、写过或加入多个选题后仍然保留，卡片会显示使用关系。原有排期、成稿和条目 ID 在升级时保留；曾直接排期的新闻会补一条独立来源记录。

1. 勾选一条或多条新闻，点「合并为一个选题」，填写标题与想回答的问题，也可加入已有选题。
2. 在日历右侧勾选素材，把其中一条拖到某天，整组素材会进入这一天的新选题。排期不会自动生成内容。
3. 点击日期查看当天全部选题。可以打开选题继续研究，也能勾选多个选题合并为一篇解读；原选题保留，可撤销。
4. 打开选题，选择公众号、小红书等平台，再选择纯文案、归藏 3:4 图文或视频脚本/分镜。纯文案和归藏卡片不调用生图模型。
5. 勾选「先查询 data MCP」，生成时重新取只读证据。查询失败或有必要数据缺口时保留错误与证据，不继续编造数据库结论。

归藏卡片从已安装 `guizang-social-card-skill` 的 Swiss seed 排版，动态内容只填文字，禁用脚本和外网，用 Playwright 导出 1080×1440 PNG。改稿后可只重新排版，不重新写作或取数。导出包包含正文、PNG、排版 HTML 与来源/数据 JSON。视频模式仍是脚本与分镜流水线，尚不渲染 MP4。

## data MCP

连接复用本机已有 `lanjing-data` MCP 条目。私有 sidecar 位于 `~/.dsh/media-desk-lanjing/data-mcp.json`，只引用已有配置，不把连接参数、凭据或真实证据提交到仓库。只允许已审计的 12 个只读工具，并核对服务端只读注解、参数边界、取消与超时；不会执行任意 SQL、刷新生产缓存或写业务数据。

「服务器洞察」频道可检查连接、读取网签概览并生成保留口径的证据卡；创作和对话可以按问题查询网签、项目、土地或已发布文章。自动研究对没有匹配口径的现房/期转现/二手房明确报缺口，不能用期房数字代替。只读 rooms 工具保留给有明确目标的查询。年鉴/工作台工具可能因当前网站会话或权限被拒绝，单独记录失败。

诊断与计划任务可直接用同一条 CLI，无需当前聊天预先注册数据库工具：

```sh
node scripts/query-data-mcp.mjs status
node scripts/query-data-mcp.mjs query lanjing_net_sign_overview '{}'
node scripts/query-data-mcp.mjs evidence '北京楼市观察' --output /absolute/private/evidence.json
```

`ok` 只说明工具调用成功，不说明结果覆盖完整。必须保留结果中的业务日期、统计范围、`complete`、`total:null` 和修订口径；`fetchedAt` 是查询时间。真实证据只允许保存到仓库外。CLI 对成功/部分成功/其他查询失败/命令错误分别返回 0/3/1/2。

## 这个分叉加了什么

一个每日自动更新的「灵感源」频道，让你每天打开工作台就有写作素材。九个频道：

| 频道 | id | 内容 |
| --- | --- | --- |
| 🏙️ 北京新闻 | `beijing-news` | 北京房产新闻 |
| 🗺️ 全国新闻 | `china-news` | 中国其他地区房产新闻 |
| 🌏 海外新闻 | `overseas-news` | 国外房产新闻 |
| 📈 宏观数据 | `macro` | 宏观经济数据（含公布时间/统计期） |
| 📜 房产政策 | `policy` | 房地产相关政策（含发文机构/要点） |
| 🏗️ 北京土拍 | `land-auction` | 土拍公告、成交、地块要点 |
| 🔥 社区热梗 | `memes` | 小红书/抖音及社区热门房产话题（公开网页） |
| 🗄️ 服务器洞察 | `server-insights` | RealEstateIntelligent 服务器网签/尾盘/土拍只读洞察 |
| ✍️ 写作问题 | `writing-prompts` | 每日从已入库素材提炼的可供选择的写作问题（编辑建议，非新闻事实） |

- 侧栏新增「**灵感源**」页（默认首页）：按频道分组、可筛选、只看未用，每条都能「**开始创作**」（沿用上游一键成稿）。
- 灵感墙上的来源条目带频道徽标。
- 其余灵感 → 成稿（脚本、标题、封面、配图、分镜）流程与上游一致。

## 灵感源如何进来

内容**不在插件里联网抓**，而是由一个「生成器」（DSH 每日定时任务）研究后推送，插件只负责幂等入库与展示。

**摄入契约**（`/sources/ingest` 接口与 CLI 共用，见 `src/sources.js`）：

```jsonc
{
  "channel": "beijing-news",           // 必填，八个 id 之一
  "date": "2026-11-06",                // 可选，默认当天
  "items": [
    {
      "title": "一句话标题（≤60字）",
      "body": "2-4句：事实摘要 + 为何值得关注 + 可写角度",
      "url": "https://原文链接",        // 可选；有则判 web 卡片，用于幂等去重
      "source": "媒体/机构名",
      "tags": ["关键词1", "关键词2"]
    }
  ]
}
```

**幂等**：同一 `url`、或同频道同标题的条目，重复推送只跳过（`skipped`），不会重复上墙。

### 手动导入（命令行）

```bash
node scripts/ingest-sources.mjs /path/to/feed.json            # 写入 ~/.dsh/media-desk-lanjing/
node scripts/ingest-sources.mjs /path/to/feed.json --store /tmp/test-store   # 指定目录（测试）
```

### 每日自动生成（DSH 定时任务）

已配置 DSH 定时任务「生成并推送每日房产灵感源」：每天 04:30（北京时间，按当前 DSH 配置）在新会话里联网检索 + 只读查询服务器，产出各频道 JSON 并调用上面的 CLI 推送。

## 安装 / 更新

```bash
npm install        # 装 esbuild
npm run build      # 打包 client/ → dist/client.js
```

在 DSH「设置 → 插件」里以 link 方式安装本目录（包名 `dsh-media-desk-lanjing`）。更新时先构建，再通过插件管理禁用/启用这个 bundle 使 Host 接口重新注册，然后刷新当前 DSH 页面。无需退出整个 DSH。

本轮已在现有 DSH 地址完成带认证接口和浏览器操作验证；不能仅凭未认证接口返回 401 判断部署成功。未运行开发 watcher 时，修改源文件不会自动完成前端重建。

## 与上游的关系 / 升级

- 路由前缀 `/media-desk-lanjing`、数据目录 `~/.dsh/media-desk-lanjing`、包名 `dsh-media-desk-lanjing`，与上游 media-desk 互不干扰、可并存。
- 同步上游时：对照 `src/`、`client/` 手工合并，注意保留本分叉的 `channels.js`、`sources.js`、`client/sources.jsx`、摄入路由与频道徽标等改动。

## 开发

```bash
npm run build      # 打包前端
npm run watch      # 开发热构建
npm test           # node --test test/*.test.js
```

目录：`src/`（Host 半片：接口、灵感源摄入、成稿）、`client/`（浏览器半片：灵感源/灵感墙/内容/排期/复盘/风格）、`scripts/ingest-sources.mjs`（摄入 CLI）、`scripts/build.mjs`（esbuild）。
