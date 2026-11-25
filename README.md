# QQ Agent（桌面端）
![平台](https://img.shields.io/badge/platform-Windows%20%7C%20Electron-lightgrey)
![技术栈](https://img.shields.io/badge/stack-Node.js%20%7C%20原生前端-orange)
一个跑在你自己电脑上的 QQ 群聊机器人：装完双击启动，扫码登录，填个模型 Key 就能用。
事件驱动 + 无状态会话架构，每次处理的 token 成本恒定可控；所有操作都在图形控制台里完成，不用碰命令行。
本项目**修改自** [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，在其基础上做了大量改造，是一个独立的 QQ agent 应用。
## 能实现什么
- **像真人一样混群**：被 @ 或被叫到时回话，平时看心情插嘴；会发文字、表情包、戳一戳，会引用、会 @ 人，知道什么时候该闭嘴
- **记住每个群友**：双向长期记忆——它记得谁是什么风格、爱什么梗、雷点是什么，下次聊天自然带上；印象页可查看每个人的有效印象、历史版本与注入画像
- **看得懂图、上得了网**：视觉模型直接看消息里的图片；内置 6 家搜索服务（含免 Key 的 Bing 网页解析），还能自己加任意兼容搜索服务
- **花多少看多少**：每次调用的 token 和成本精确记录，按天 / 按会话 / 按模型三个维度统计，缓存命中率、峰谷分时计价、图片计费口径全标清楚
- **零编程门槛**：所有配置都在控制台点选——白名单从 QQ 里直接勾选群，模型从模型目录里点选切换，不用查群号、不用写配置
## 技术架构
**事件驱动 + 无状态会话（成本控制的核心）**
1. 群聊消息持续写入本地 JSON 存档（每条带时间与已读状态）
2. 每次有新消息（或主动机会），**新开一个独立会话**：提示词 = 静态系统提示（人设/规则/策略）+ 存档摘要 + 本次新消息
3. 会话结束即弃置，LLM 层面零历史——一次处理的成本是恒定小份，不随聊天量膨胀
4. 处理期间新来的消息只写存档；本次结束后发现未读 → 自动再开新会话，直到清空
5. 长期信息走记忆工具持久化，跨运行生效
**整体组成**
- **协议端**：通过 OneBot v11 正向 WebSocket 接 QQ（默认配 SnowLuma，任何兼容协议端均可换）
- **大脑**：任意 OpenAI 兼容 API——官方 / 中转站 / 本地网关均可，模型在设置里自选
- **桌面壳**：Electron，托盘常驻、开机自启、关窗不退出、端口被占自动让位
- **控制台**：零框架原生 HTML/CSS/JS，明暗双主题 + 跟随系统，带完整设计 token 体系
- **安全边界**：工具天然绑定会话（模型无法把消息发到别的群）、发送白名单 + 限频、联网抓取带完整 SSRF 防护（DNS 校验 / IP 固定 / 手动跟重定向）、图片地址禁内网
## 设置项都能做什么
**模型 API**
- 多提供商模型目录：填 Base URL + Key，点「获取列表」自动拉模型，选中即切换；中转站返回几百个模型时内置搜索 + 厂商/模型双栏
- 一键测试：发个 ping 立刻验证地址/Key/模型通不通，显示延迟
- 成本核算：内置 140 个模型的官方价格表自动匹配；走中转站可关掉官方价自填单价，支持「渠道：模型」两级定价、峰谷分时、图片计费规则提示
- 视觉开关：模型不支持图片时关掉，看图工具自动从提示词移除
**聊天设置**
- **响应档位滑条**（省 token 核心）：0~100 无级调节——1 档仅 @ 响应、2 档 +关键词、3 档按概率随机响应（滑条位置线性决定概率）、4 档全响应；没命中的消息直接标已读，零 token 消耗。触发原因决定上下文条数：被 @ 时永远带最多上下文
- **表情包积极程度** 0~4 档：不鼓励 / 偶尔 / 较积极 / 很积极 / 非常积极（提示词层面引导，不强制）
- 人设系统：内置「小鲸鱼」角色卡开箱即用，多套模板一键填充可改；参与度风格（安静/普通/活跃）可调
- 关键词、每群独立开关、私聊开关、屏蔽名单（被屏蔽者不存档、不触发、不进提示词）
**记忆**
- 自动记录对群友的长期印象，经候选池与新版本机制逐步生效；控制台可按人物查看有效印象、历史版本与注入画像
- 成员备注保存在 `data/config.json` 的 `memberNotes`，控制台不提供编辑入口
**搜索服务**
- 6 家内置（Bing 免 Key / DeepSeek / 智谱 / 博查 / 百度千帆 / 秘塔）+ 自定义添加任意兼容服务，可加多个
**白名单**
- 从 QQ 账号拉群列表/好友列表直接勾选；机器人只对名单内的会话工作
**桌面端**
- 托盘常驻 / 开机自启 / 关窗不退出；明暗主题
**OneBot**
- 协议端地址可改，适配任何 OneBot v11 实现
## 界面一览
- **会话**：每次处理一个会话卡片，完整留档——提示词、思考、工具调用与结果、实际发出的每条消息、用量；运行中实时刷新
- **存档**：每个群/好友的消息库，未读标记一目了然；可手动唤醒一次处理或全部标已读
- **印象**：每个群友一份档案，可查看有效印象、历史版本与注入画像
- **用量**：三维度统计 + 下钻明细 + 调用次数明细（内置 28 种工具按类别分组的趣味统计，启用 Skill 后还会更多）
- **设置**：以上所有
## 仓库范围与隐私

本仓库是**源码仓库**，不包含运行数据与第三方二进制：`data/`、`runtime/`、`SnowLuma/`、`tools/`、`server/`、`node_modules/`、`dist/` 均不随仓库分发，也不包含个人评测脚本与便携包上传工作流。

- **群二维码**：`ui/group-qrcode.svg` 是示例占位图，使用前请替换为自己的群二维码。
- **欢迎表情**：公开版不内置欢迎表情（`WELCOME_STICKER_ID` 为占位值），需要时可自行填入。
- **测试数据**：仓库内测试使用合成 QQ 号与群号，不含任何真实用户信息。
## 扩展（两型：插件 / Skill）

扩展分**两型**，按"什么时候该运行"来选，放进对应目录即生效：

| 类型 | 放哪 | 靠什么生效 | 谁决定何时执行 |
|---|---|---|---|
| **确定性型（插件）** | `plugins/<id>/` | 能力 `providers` / 钩子 `hooks` | **核心代码**：满足条件必然执行，不经过 LLM |
| **LLM 型（Skill）** | `skills/<id>/` | 工具 `registerTool` + 提示词片段 | **模型**：看工具说明自己判断 |

```
plugins/my-plugin/            skills/my-skill/
  plugin.json  清单              skill.json   清单
  index.js     providers/hooks   index.js     registerTool
```

判据一句话：**规则能写死 → 插件（`plugins/`）；要理解人话 → 技能（`skills/`）**。
（完整的定义与三问判断法见两份开发文档的 §0。）
选错类型的后果是**功能静默失效**（不报错、不崩、就是没反应），所以两份开发文档请先读：

- **确定性型** → [doc/extend_development/plugin-development.md](doc/extend_development/plugin-development.md)
- **LLM 型** → [doc/extend_development/skill-development.md](doc/extend_development/skill-development.md)
- 共同机制完整参考 → [doc/extend_development/skill-reference.md](doc/extend_development/skill-reference.md)

其它约定：

- **开关只有一处**：`config.skills[id].enabled`。关掉一个扩展，它注册的工具、
  提供的能力、提示词片段、请求改写会**同时**失效 —— 不会出现"界面关了但还在偷偷工作"。
- **按能力依赖，不按名字**：核心模块问"谁提供 `llm.request-params`"，
  不 import 具体扩展，所以换实现不用改核心代码。
- **不可能覆盖安全规则**：扩展的提示词片段优先级被强制压在核心规则之下。
- **状态可解释**：控制台的「技能」与「插件」两个页签各自直接告诉你为什么某项没生效
  （未启用 / 依赖缺失 / 加载失败 / 模型不支持），不是笼统的"工具关闭"。
- **两种清单文件功能等价**：`plugin.json` 与 `skill.json` 走同一条规范化流程，
  目录只决定语义分类，不限制能用哪些特性。
- 目录出厂为空：`skills/` 与 `plugins/` 是用户后装扩展的落点，插上就能用、删掉就消失；
  思考模式等核心能力已内置进 `src/`，不依赖任何扩展。
- **热重载默认开启**：目录放进去就生效，无需重启（`config.extensions.hotReload` 可关；
  等价于"任意落地的 JS 会被执行"，共享机器建议关掉）。
- 架构总览见 [doc/extend_development/skill-system.md](doc/extend_development/skill-system.md)。
## ffmpeg（可选，图片/视频处理需要）

图片压缩与视频抽帧需要 ffmpeg。请从 [gyan.dev 的 Windows 构建](https://www.gyan.dev/ffmpeg/builds/)（release essentials）下载，解压后把 `ffmpeg.exe` 放到 `tools/ffmpeg/ffmpeg.exe`。查找顺序：`QQ_AGENT_FFMPEG` 环境变量 → 项目内 `tools/ffmpeg/` → 系统 PATH。

本仓库验证所用版本：`ffmpeg version 2022-10-30-git-ed5a438f05-essentials_build-www.gyan.dev`。
## 语音识别（可选，本地运行）

装上之后：语音消息入库时从 `[语音]` 变成 `[语音转文字] 内容…`；`read_video` 的说明里
多一句「音轨转写：…」。**不装就与以前完全一样**（内容、文案一字不差），删掉
`plugins/media-audio/` 即可完整回退。

- 引擎：sherpa-onnx v2.0.1 + SenseVoice（中/英/日/韩/粤，非自回归）
- 全程本地推理，**不联网**；不做音乐识别，也不调 QQ 自带的转文字
- 占用：**约 254MB**（模型 228MB + 可执行与 DLL 约 25MB）

### 需要自己下载两个文件

```bash
# 1) 可执行文件（用 shared 版，别用 non-streaming-asr 单文件版，见下方说明）
#    https://github.com/k2-fsa/sherpa-onnx/releases/tag/v2.0.1
#    资产：sherpa-onnx-v2.0.1-win-x64-shared-MT-Release.tar.bz2
#    取出 bin/ 下的这 4 个文件，放到 tools/sherpa/：
#      sherpa-onnx-offline.exe
#      onnxruntime.dll
#      onnxruntime_providers_shared.dll
#      sherpa-onnx-c-api.dll

# 2) 模型（约 228MB）
#    https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/
#      sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2
#    解压后把整个目录改名成 tools/sherpa/sense-voice/，里面应有：
#      model.int8.onnx   tokens.txt   （test_wavs/ 可留可删）
```

最终目录：

```
tools/sherpa/
├─ sherpa-onnx-offline.exe        # 2.7MB
├─ onnxruntime.dll                # 17MB
├─ onnxruntime_providers_shared.dll
├─ sherpa-onnx-c-api.dll          # 4.3MB
└─ sense-voice/
   ├─ model.int8.onnx             # 228MB
   ├─ tokens.txt
   └─ test_wavs/                  # 自带测试音频，用来验证装好没有
```

验证装好了没（应输出一句中文）：

```bash
tools/sherpa/sherpa-onnx-offline.exe \
  --tokens=tools/sherpa/sense-voice/tokens.txt \
  --sense-voice-model=tools/sherpa/sense-voice/model.int8.onnx \
  --num-threads=4 --sense-voice-use-itn=1 --debug=0 \
  tools/sherpa/sense-voice/test_wavs/zh.wav
```

> **为什么不用 `sherpa-onnx-non-streaming-asr-x64-v2.0.1.exe` 单文件版**：
> 实测它是 PE **GUI 子系统**（Subsystem=2），被 `spawn` 出去后 60 秒不写一个字节，
> 管道与重定向都拿不到输出，退出码还不稳定。同版本的 shared 包里的
> `sherpa-onnx-offline.exe` 是 console 子系统，参数完全一致、行为正常。

### 开关与调参

设置页 → 插件 →「语音识别」，或直接改 `config.skills['media-audio']`：

| 项 | 默认 | 说明 |
|---|---|---|
| `enabled` | 开 | 总开关，关掉即完全回退 |
| `maxThreads` | 4 | 推理线程数；核数少于 4 就设成核数 |
| `voiceMaxSec` / `videoMaxSec` | 60 / 180 | 超过部分不处理，并标注「只处理了前段」 |
| `voiceBudgetMs` / `videoBudgetMs` | 8000 / 25000 | 超时就用已识别的部分，绝不无限等 |
| `voiceStartWaitMs` | 8000 | 排队等多久就放弃（并发时保持 `[语音]`） |
| `queueDeadlineMs` | 60000 | 绝对死线，兜底 |
| `useItn` | 开 | 自动加标点、把「二零二六」规范成「2026」 |

覆盖路径（换机器 / 放在别处）：`QQ_AGENT_ASR=<exe 路径>`、`QQ_AGENT_ASR_MODEL=<模型目录>`。
设了就是**独占**，不会再去 `tools/sherpa/` 找。

### 实测性能（本机，4 线程 CPU）

| 音频 | 耗时 | RTF |
|---|---|---|
| 5.6 秒 | 1.38 秒 | 0.25（含约 1.1 秒模型加载） |
| 60 秒 | 3.70 秒 | 0.062 |
| 180 秒 | 17.85 秒 | 0.099 |

### 已知边界

- 转发消息里的语音仍是 `[语音]`（转发链不传 onebot，取不到音频）
- 纯音乐：说「音轨里没有检测到人声」，说不出是什么歌。判据用的是 `lang=nospeech` 标签，**不是**音频事件标签
- **音乐较响的音频（番剧对白叠配乐、MV）照样转写并照常给出**，并标注语种，只说「连贯成句的是说话内容，支离破碎、大段重复的多半是歌词」，把定性交给模型。
  音频事件标签（AED）常把「对白＋配乐」判成 `BGM`（22 条真实视频里错判率过半），**不能用来判断有没有人声**——
  早期版本据此否决文本，导致模型把一句听得清清楚楚的日语台词说成「视频里没说话」（2026-11-08 修了两次：先拆掉否决，再把判据从 event 换成 lang）
- 唱歌：按歌词方式解码，分词和错字都多、可读性差，但不做额外压制，错字由模型自己判断
- 极短幻觉：纯音乐偶尔会被凑出一两个字（实测 9 秒 BGM 得出「我」），去标点后不足 2 字的一律丢弃
- 强噪声、多人抢话：结果不可靠（不区分说话人，整段一个文本）
- 语音消息识别失败与没人声**都显示 `[语音]`**（`transcribeVoice` 只看文本是否非空）
- 通道正忙：视频 10 秒、语音 8 秒没轮到就跳过，不重试（有意取舍，见插件说明）
- 视频缓存（`data/video-cache`）：入站预缓存下来的文件**保留 72 小时、目录最多 2GB**，超出时先删最老的。
  这两条闸独立于 `store.retentionDays`（默认 180 天），否则活跃群会把磁盘吃光；
  同理，把 `retentionDays` 设 0 也不会让视频缓存无限长。可用 `store.videoCacheHours` /
  `store.videoCacheMaxMb` 调整，任一设 0 = 关闭该闸。
  删掉后不影响正在进行的对话，只是历史视频再被读时会重新尝试取文件（直链过期则取不到）

## 安装与使用
**三步搞定**（推荐）：
```bash
git clone https://github.com/K0nd1us/QQ-agent.git
cd qq-agent
npm install
npm run setup    # 自动下载 SnowLuma + 固定版本便携 QQ
```
然后双击 `启动QQ机器人.bat`（或 `npm start`），在 SnowLuma 页签点「启动 QQ」，扫码登录即可。
**手动安装**（如果 `npm run setup` 下载失败）：
1. **装协议端**：SnowLuma 是独立第三方项目（自带 EULA，不随本仓库分发），从其官方渠道获取后解压到项目根目录，目录名保持 `snowluma`
2. **装便携 QQ**（可选）：
   - **最省事**：机器上已经装过 QQ 的话，**先完全退出 QQ**，直接跑 `npm run setup` ——
     脚本会从注册表找到已装的 QQ 并复制一份到 `runtime/qq-portable/`（约 1.6 GB，会自动跳过聊天记录）
   - 否则：下载 <https://www.kondius.cn/netdisk/api/download/QQ_9.9.33_260813_x64_01.exe>
     （约 300 MB），**正常双击安装一遍**，然后退出 QQ、重跑 `npm run setup`
   - 为什么不能自动静默安装：QQ 9.9.x 用的是腾讯自研的 **HummerSetup** 安装器，
     不接受 NSIS/Inno 的静默开关（脚本会识别出来并说明，而不是盲试到超时）
3. **启动**：双击 `启动QQ机器人.bat`（或 `npm start`），扫码登录 QQ
4. **配置**：设置页顶部体检卡会告诉你缺什么——填接口地址和 Key → 选模型 → 勾白名单
```bash
npm install          # 装依赖
npm run setup        # 一键下载 SnowLuma + 便携 QQ（幂等，可重复执行）
npm run setup:check  # 只检查是否已就绪
npm start            # 桌面端启动
npm run server       # headless 模式：浏览器打开 http://127.0.0.1:3210
npm test              # 全量测试：自测 + Skill 架构 + 工具/Skill 审查 + 链接媒体转发 + 回复抢救 + 技能设置 + 表情上下文 + 技能弹窗 + 渲染 + 滚动 + 用量端到端 + 提示词
npm run test:coverage # 覆盖测试（模块层 + 全部 HTTP 接口 + 端到端链路 + 静态界面层 + 界面接线）
npm run test:all      # 两套一起跑
npm run test:wiring   # 只跑「界面接线」检查（需要可选依赖，见下）
```
### 界面接线检查（可选依赖）
`test/coverage-wiring.mjs` 用 jsdom 加载真实的 `ui/index.html` 并执行 `ui/app.js`，
然后按用户的真实操作路径（点页签 / 点设置分区 / 打开各弹窗）遍历，断言
**每一个交互元素（按钮、输入框、下拉框…）都有代码在管**，并回归验证
「展开全部/收起」这类折叠按钮真的能开合。
它依赖 jsdom，但 jsdom 不是本项目的依赖 —— 未安装时该测试会打印提示并**自动跳过**，
不影响其它套件。想启用：
```bash
npm i -D jsdom      # 装完再跑 npm run test:wiring 即可
```
### QQ 怎么来的？（免安装包，推荐）
QQ 9.9.x 用的是腾讯自研的 **HummerSetup** 安装器，**不支持静默安装**（会弹 GUI）。
更麻烦的是：**机器上已有更新版本时，根本装不回指定版本**（会拒绝或直接升级掉），
而且为了做个便携版去覆盖用户日常用的 QQ，代价也不对。
所以 **QQ 以「免安装包」形式分发**：下载解压即用，**完全不需要安装 QQ**，
也不触碰系统里已装的任何东西。
```bash
npm run setup          # 自动下载免安装包 → 校验 SHA256 → 解压 → 完成
```
免安装包的特点：
- **不需要装 QQ**，解压约 1.5 GB，不写注册表、不装服务
- **不与系统里已装的 QQ 冲突**（启动时带 `--user-data-dir`，数据完全隔离）
- **不含任何用户数据**（聊天记录、登录态、账号 —— 一个字节都没有）
- 剥离了运行日志与卸载器（卸载器指向原安装路径，带过去会误导）
- 保留全部许可文件（`QQLicense.rtf` / `LICENSE.electron.txt` 等）
#### 自己打包一份
如果分发地址不可用，或你想用自己机器上的 QQ 版本：
```bash
npm run pack:qq                    # 打包 runtime/qq-portable → dist/QQ_portable.tar.zst
npm run pack:qq -- --from <你的QQ安装目录>    # 或从别处打包
npm run pack:qq -- --keep-updates  # 保留待安装的更新包（默认剥离）
```
打包脚本会打印出归档的 SHA256 和两行可直接粘贴的配置（`QQ_PORTABLE_URL` / `QQ_PORTABLE_SHA256`）。
把归档上传到任意可直链下载的地方即可。
> ⚠️ QQ 是腾讯公司的专有软件，版权与许可归腾讯所有。
> 免安装包只是为了让「免安装」成为可能而做的**复制**，不含任何修改；
> **再分发前请自行确认符合腾讯的许可条款**。本仓库不随代码分发 QQ 本体。
#### 目标版本 vs 兜底安装包（两个不同的产物）
| | 是什么 | 版本 |
|---|---|---|
| **目标版本** `QQ_VERSION` | 我们要求协议栈打交道的客户端版本；`EXPECTED_CLIENT_BUILD` 由它推导 | `9.9.33.51802` |
| **免安装包** | 分发的主体，解压即用 | 里面就是 `9.9.33-51802` |
| **兜底安装包** `QQ_9.9.33_260813_x64_01.exe` | 只在"免安装包拿不到 + 机器上也没装 QQ"时用（且必须手动双击装） | `260813` |
兜底安装包的**文件名是写死的，不再由版本号拼接** —— 分发站上现存的就是 260813 那个包。
用版本号拼的话一旦拼错，兜底下载会 404，而报错只会说"下载失败"，很难联想到是文件名不存在。
#### 兜底：从机器上已装的 QQ 复制
免安装包下载失败（比如没网、地址失效）时，会自动退回这条路：
```bash
# 完全退出 QQ（含托盘）后：
npm run setup
# 装在自定义路径时指定：
npm run setup -- --from "D:\你装到哪"
# 强制不用免安装包，就走复制：
npm run setup -- --no-portable
```
脚本按「`--from` 指定 → 注册表/常见路径里**版本匹配**的那份 → 读不到版本的 → 版本不符的（会警告）」
的顺序选来源，**不会随手拿第一个** —— 机器上同时有 QQ 9.7 和 9.9 时，拿错版本会表现为登录失败，
排查方向会完全跑偏。
### 为什么内置固定版 QQ？
- **版本锁定与对齐**：SnowLuma 协议栈里写死了两处"我是谁"的声明
  （`CLIENT_BUILD`、`BUILD_VERSION_SHORT`），用来在握手时自称客户端版本。
  `npm run setup` 会把它们**对齐到你实际运行的 QQ 版本**（当前 `9.9.33-51802`），
  这样声明与实际一致，也不会再报版本不匹配。
  - 只是握手自报家门的字段，**不参与任何协议分支选择**（全文只有 2 处引用，都在自定义表情服务里）
  - 改之前备份成 `snowluma/index.mjs.orig`；需要还原就把它盖回去
  - 关掉对齐：`set QQ_ALIGN_CLIENT_BUILD=0 && npm run setup`
  - 之所以做在 setup 里而不是手改：`snowluma/` 是下载来的，重新 setup 会覆盖掉手改的改动
- **下载源**：从 <https://www.kondius.cn/netdisk/api/download/> 取安装包
  （不依赖腾讯 CDN 的文件名规则，也不会因 CDN 清档而 404）。
  目标版本 `9.9.33.51802`（免安装包里的就是这一版）。
- **完整性校验**：安装包的 SHA256 已固定（`B25C0D3C…EC492`，2026-09-13 实测下载并校验）。
  换版本/换源时要**同步改掉它**，否则每次 setup 都会以"校验失败"告终；
  也可以设空 `QQ_X64_SHA256` 临时跳过（跳过后会打印实际哈希，方便重新固定）。
- **安装器类型**：QQ 9.9.x 用的是腾讯自研 **HummerSetup**（不是 NSIS/Inno），
  `/s /D=` 这类开关无效。脚本会识别类型，对这类安装器**不去盲试**，
  而是改用"复制机器上已装的 QQ"这条路（做便携运行靠的是 `--user-data-dir`，不需要干净副本）。
- **完全隔离**：便携 QQ 使用独立 `--user-data-dir`，与用户日常 QQ 互不干扰
- **精准控制**：关闭时只杀路径匹配 `runtime/qq-portable` 的进程，绝不碰用户已登录的 QQ
> ⚠️ **换 QQ 版本前先看这里**：如果登录被拒或接口行为异常，优先怀疑版本不匹配，
> 而不是网络或账号。setup 的提示里会给出两个方向 ——
> 换回与协议栈匹配的 QQ 版本，或换一个与当前 QQ 版本匹配的 SnowLuma。
### 风险与免责声明
- 本项目通过非官方方式接入 QQ 协议，**账号存在被风控/封禁的风险**，建议使用小号
- SnowLuma 是独立第三方项目，受其自身 EULA 约束，本项目不分发其代码
- 用户自行承担使用本项目的所有风险
### 分发前脱敏
分享自己的部署副本前执行：
```bash
node scripts/sanitize-release.mjs --dry-run   # 先看会清理什么
node scripts/sanitize-release.mjs             # 清空 Key / 白名单 / 存档 / 登录态
```
## 开发与测试

需要 Node.js ≥ 20。`npm install` 后执行 `npm test`；`npm run test:coverage` 跑覆盖测试。部分视频/语音相关测试需要先按上文放好 `tools/` 下的二进制（ffmpeg / sherpa），缺少时相关用例会跳过或报环境缺失。
## 致谢
- **[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)**——本项目修改自该项目，"仿真群友"的思路是这一切的起点
- **SnowLuma**——QQ 协议端（OneBot v11）提供者，独立第三方项目，受其自身 EULA 约束
由 **Kondius** 开发与维护。
## 许可
本项目以 MIT 许可发布（见 [LICENSE](LICENSE)）。前置依赖 SnowLuma 是独立项目，受其自身许可约束，不受本项目许可覆盖。
