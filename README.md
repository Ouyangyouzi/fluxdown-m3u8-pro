# M3U8 超级下载器 Pro · FluxDown 插件

把 M3U8 主播放列表交给 [FluxDown](https://fluxdown.com) 的下载引擎：列出全部清晰度、按偏好预选、用网页标题命名、自动补 Referer/UA，并识别独立音轨、AES-128 与直播列表。

`community@m3u8-pro` · 0 权限 · 0 网络主机 · 风险等级 `standard`

[![test](https://github.com/USER/fluxdown-m3u8-pro/actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 这是什么

一份油猴脚本（`M3U8 超级下载器 Pro v6.1`，1673 行）的 FluxDown 原生重写。

脚本里最重的部分——分段并发下载、AES-128 解密、`EXT-X-MAP` 初始化段、合并落盘、IndexedDB 断点续传、进度/速度/ETA、悬浮面板——**FluxDown 引擎本身做得更好**，所以全部删掉。插件只保留脚本里真正值钱的三件事：

1. 认清主列表里的全部清晰度，交给 FluxDown 原生的画质选择框；
2. 用网页地址给任务起一个像样的文件名（引擎默认只会拿播放列表名）；
3. 补齐防盗链需要的 Referer / UA，并把独立音轨、AES-128、直播这些情况写进日志。

## 能力映射

| 油猴脚本 | 在 FluxDown 里的归属 | 本插件 |
| --- | --- | --- |
| Hook XHR/fetch + 轮询 `<video>` 嗅探 | 浏览器扩展的嗅探引擎（官方规则已把 `.m3u8`/`.mpd` 认成 `stream`） | 不实现 |
| 解析主列表 + `window.prompt` 选清晰度 | 引擎原生画质选择框 | **保留**：`variants` + `defaultVariantIndex` |
| 8 并发分段下载、每片 3 次重试 | 引擎（默认 8 并发、上限 16、失败退避重试） | 删除 |
| AES-128 解密、密钥缓存 | 引擎 | 删除 |
| `EXT-X-MAP` + 按序拼接合并 | 引擎（fMP4/TS，必要时 ffmpeg 转封装） | 删除 |
| IndexedDB 任务存储、跨页面续传 | SQLite(WAL) + 断点续传 | 删除 |
| `GM_download` / Blob 保存 | 引擎直接落盘 | 删除 |
| 进度条、速度、ETA、暂停/取消、任务搜索 | FluxDown 自己的 UI | 删除 |
| `document.title` → 文件名 | 扩展捕获时带上的文件名；HTTP 任务靠元数据探测 | **保留**：Referer 末段，弱名退到域名 |
| 请求头里的 Referer / Origin | 引擎按任务携带的请求头下载 | **保留**：补齐 Referer/UA，Origin 可选 |
| 独立音轨另存 `.audio.ts` | 引擎的「轨对任务」下载后自动 mux | **保留**（实验性）：`audioUrl` |
| 直播列表 | 引擎的直播录制模式（脚本没有这个能力） | 只识别、只记日志 |

## 安装

**插件市场**：在 FluxDown 的应用内插件市场搜索「M3U8 超级下载器 Pro」（上架后）。

**`.fxplug` / `.zip`**：从 [Releases](../../releases) 下载 `community-m3u8-pro-<version>.fxplug`，然后到 **设置 → 扩展 → 插件**，打开 **开发模式**，点 **安装 .fxplug / .zip 插件** 选中它。

> 上传入口只在开发模式打开时出现；关着的时候只有插件市场。

**从目录（开发）**：把本仓库根目录（含 `manifest.json` 的那一层）装进去，改代码后 `resolve.js` 每次调用都会重新读取，无需重装。

## 设置项

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `maxHeight` | `1080` | 画质框默认项。`best` = 最高码率；其余取「不超过该高度的最高一档」，都比它高就取最低档。 |
| `container` | `auto` | 文件名扩展名。`auto`：主列表按 `mp4`，媒体列表看有没有 `EXT-X-MAP`（fMP4 → `mp4`，TS → `ts`）。**实际容器由引擎决定**，名字对不上就改这里。 |
| `nameSource` | `referrer` | `referrer` 用网页地址末段；`playlist` 用播放列表名；`none` 不干预。 |
| `injectHeaders` | 开 | 任务没带 Referer/UA 时用任务记录的那份补上，不覆盖已有头。 |
| `injectOrigin` | 关 | 只有 CDN 明确要 Origin 时才开；签名地址带上它可能被拒。 |
| `attachAudio` | 关 | 把 `EXT-X-MEDIA` 的音轨作为 `audioUrl` 交给引擎合并。见「已知边界」。 |

## 工作原理

```
任务 URL 含 "m3u8"
   └─ resolve(ctx)
        ├─ flux.fetch 拉一次播放列表（带任务 Cookie/Referer/UA）
        ├─ 非 #EXTM3U 响应 / HTTP 非 2xx / 网络错误 → return null（放行，交回引擎）
        ├─ 媒体列表（有 EXTINF、无 STREAM-INF）
        │     → { url, fileName, extraHeaders }   ← 引擎照常下分段、解密、合并
        └─ 主列表（有 STREAM-INF）
              → { url: 默认档, variants: [全部档位], defaultVariantIndex,
                  fileName, extraHeaders }          ← 引擎弹自己的画质框
```

关键取舍：**任何一步不确定就 `return null` 放行**。脚本原来的 fail-closed 是为了不把 HTML 存成视频；这里引擎自己会看 MIME，放行比让任务报错更有用。只有「拿到了合法 M3U8 但解析不出档位」才真正失败。

`url` 与 `variants` 同时返回：即使宿主不认识 `variants`，也能直接下默认档而不是失败。

## 已知边界

1. **没有「全站嗅探」**。插件跑在 daemon 的 QuickJS 沙箱里：没有 DOM、没有 `fetch`/`URL`/`setTimeout`。页面级能力只有扩展示例中的嗅探规则与页面脚本两条路，且两者都要求显式 host 白名单，写不了 `*://*/*`。抓流靠扩展，本插件负责「地址到手之后」。补站点用 [`examples/sniff-rules.example.json`](examples/sniff-rules.example.json) 的格式。
2. **SAMPLE-AES / SAMPLE-AES-CTR 不支持**。FluxDown 只自动解 `AES-128-CBC`；插件会识别并写一条 warn，任务多半会失败。
3. **`attachAudio` 是实验性的**。引擎文档里的 `audioUrl` 面向「DASH 风格的音视频分离」，HLS 的 `EXT-X-MEDIA` 音轨喂给它能否正确 mux 取决于版本与 ffmpeg。默认关闭；音画不同步就关掉。
4. **扩展名只是命名**。`container` 只影响文件名，不改输出容器；有没有装 ffmpeg 会改变最终容器。
5. **播放列表会被重复拉取**。resolver 是惰性的，任务每次开始和**恢复**都会重新跑一遍（直链会过期），所以带令牌的地址要保证可重放。

## 开发

```
manifest.json                        插件声明：匹配 *m3u8*、6 个设置、0 权限
resolve.js                           唯一入口（经典脚本，globalThis.resolve）
examples/sniff-rules.example.json    可选：host 级嗅探规则模板（不参与插件运行）
scripts/pack.py                      打包成 .fxplug（固定时间戳，可复现哈希）
tests/                               离线用例，不联网、不需要 FluxDown
```

```bash
# 解析逻辑：主列表/媒体列表/直播/AES/相对路径/命名/放行分支，23 个用例
node tests/test-resolver.mjs

# manifest 规则 + 安装期编译检查（空白上下文求值：顶层不许碰 flux）
node tests/test-manifest.mjs

# 打包
python3 scripts/pack.py

# 官方校验（客户端安装与插件市场准入用的是同一份规则）
npx fluxdown-plugin-sdk@0.5.1 validate
```

`npx fluxdown-plugin validate` 读的是 `dist/`；本仓库没有构建步骤，可以把根目录的 `manifest.json` 与入口脚本拷进 `dist/` 再校验。

### 发布到插件市场

1. 在自己的公开仓库发布一个 GitHub Release，附件里**恰好一个** `.fxplug`；
2. 向 [zerx-lab/fluxdown-plugin-index](https://github.com/zerx-lab/fluxdown-plugin-index) 提交只改 `registry.json` 的 PR：

```json
{ "id": "community@m3u8-pro", "repo": "<owner>/fluxdown-m3u8-pro", "tags": ["resolver", "video", "hls"] }
```

`id` 必须等于 manifest 的 `identity`；之后每次发 Release 都会被自动收录。

## 许可

[MIT](LICENSE)。插件格式与 [`fluxdown-plugin-sdk`](https://www.npmjs.com/package/fluxdown-plugin-sdk) 由 FluxDown 以 AGPL-3.0 提供，本仓库只使用其公开协议与校验规则，不包含其代码。
