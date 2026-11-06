// 离线验证：不依赖 FluxDown，也不联网。
// 用法：node _build/test-resolver.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const ROOT = path.resolve(import.meta.dirname, "..");
const CODE = fs.readFileSync(path.join(ROOT, "resolve.js"), "utf8");

const MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="中文",LANGUAGE="zh",DEFAULT=YES,URI="audio/zh.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2400000,AVERAGE-BANDWIDTH=2200000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"
v/720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5200000,AVERAGE-BANDWIDTH=4800000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"
v/1080/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=854x480,AUDIO="aud"
/v/480/index.m3u8
`;

const MEDIA_FMP4 = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=AES-128,URI="../key.bin",IV=0x1234
#EXTINF:6.0,
seg1.m4s
#EXTINF:6.0,
seg2.m4s
#EXT-X-ENDLIST
`;

const MEDIA_LIVE = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
s1.ts
#EXTINF:4.0,
s2.ts
`;

function load({ body = "", status = 200, settings = {}, throwOnFetch = false } = {}) {
  const logs = [];
  const fetched = [];
  const sandbox = {
    console,
    flux: {
      settings,
      fetch: async (opts) => {
        fetched.push(opts);
        if (throwOnFetch) throw new Error("fetch 失败: dns error");
        return { status, headers: {}, body, truncated: false };
      },
      logger: {
        info: (m) => logs.push(["info", m]),
        warn: (m) => logs.push(["warn", m]),
        error: (m) => logs.push(["error", m]),
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox);
  return { resolve: sandbox.resolve, logs, fetched };
}

const ctx = (url, extra = {}) => ({
  taskId: "t1",
  url,
  cookies: "sid=abc",
  referrer: "https://www.example.com/watch/星际穿越-4K",
  userAgent: "UA/1.0",
  extraHeaders: {},
  authRef: "",
  resolverItem: "",
  ...extra,
});

const cases = [];
function test(name, fn) {
  cases.push([name, fn]);
}

test("主列表：解析 3 档、按码率降序、默认 1080p", async () => {
  const { resolve, logs } = load({ body: MASTER });
  const out = await resolve(ctx("https://cdn.example.com/hls/master.m3u8?token=1"));
  assert.equal(out.variants.length, 3);
  // 跨 vm 实界的数组原型不同，比较 JSON 而不是引用结构
  assert.equal(JSON.stringify(out.variants.map((v) => v.height)), "[1080,720,480]");
  assert.equal(out.defaultVariantIndex, 0);
  assert.equal(out.variants[0].url, "https://cdn.example.com/hls/v/1080/index.m3u8");
  assert.equal(out.variants[2].url, "https://cdn.example.com/v/480/index.m3u8"); // / 开头
  assert.equal(out.url, out.variants[0].url); // 兜底地址
  assert.equal(out.fileName, "星际穿越-4K.mp4");
  assert.equal(out.variants[0].label, "1080p · 4.80 Mbps · avc1.640028");
  assert.equal(out.variants[0].audioUrl, undefined); // 默认不附加音轨
  assert.ok(logs.some(([, m]) => m.includes("3 档清晰度")));
  console.log("  日志:", logs.map(([l, m]) => `${l}:${m}`).join(" | "));
});

test("偏好 720p：默认索引落到 720p 而不是最高", async () => {
  const { resolve } = load({ body: MASTER, settings: { maxHeight: "720" } });
  const out = await resolve(ctx("https://cdn.example.com/hls/master.m3u8"));
  assert.equal(out.variants[out.defaultVariantIndex].height, 720);
  assert.equal(out.defaultVariantIndex, 1);
});

test("偏好 480p：命中最低档", async () => {
  const { resolve } = load({ body: MASTER, settings: { maxHeight: "480" } });
  const out = await resolve(ctx("https://cdn.example.com/hls/master.m3u8"));
  assert.equal(out.variants[out.defaultVariantIndex].height, 480);
});

test("偏好低于全部档位：退到最低档", async () => {
  const { resolve } = load({ body: MASTER, settings: { maxHeight: "240" } });
  const out = await resolve(ctx("https://cdn.example.com/hls/master.m3u8"));
  assert.equal(out.variants[out.defaultVariantIndex].height, 480);
});

test("attachAudio：把 DEFAULT=YES 的音轨作为 audioUrl 下发", async () => {
  const { resolve } = load({ body: MASTER, settings: { attachAudio: true, maxHeight: "best" } });
  const out = await resolve(ctx("https://cdn.example.com/hls/master.m3u8"));
  assert.equal(out.variants[0].audioUrl, "https://cdn.example.com/hls/audio/zh.m3u8");
});

test("媒体列表 fMP4 + AES-128：不返回 variants，扩名 mp4", async () => {
  const { resolve, logs } = load({ body: MEDIA_FMP4 });
  const out = await resolve(ctx("https://cdn.example.com/hls/v/1080/index.m3u8"));
  assert.equal(out.variants, undefined);
  assert.equal(out.url, "https://cdn.example.com/hls/v/1080/index.m3u8");
  assert.equal(out.fileName, "星际穿越-4K.mp4");
  assert.equal(out.extraHeaders.Referer, "https://www.example.com/watch/星际穿越-4K");
  assert.equal(out.extraHeaders["User-Agent"], "UA/1.0");
  assert.ok(logs.some(([, m]) => m.includes("加密 AES-128")));
  assert.ok(logs.some(([, m]) => m.includes("fMP4")));
  // 分片数不能算成两倍（EXTINF + URI 各一行）
  assert.ok(logs.some(([, m]) => m.includes("2 个分片")), logs.map(([, m]) => m).join(" | "));
});

test("Windows 保留设备名会被改写", async () => {
  const { resolve } = load({ body: MEDIA_LIVE });
  const out = await resolve(ctx("https://cdn.example.com/x/index.m3u8", { referrer: "https://a.com/nul" }));
  assert.equal(out.fileName, "_nul.ts");
});

test("媒体列表 TS 分片：auto 扩名落到 ts", async () => {
  const { resolve } = load({ body: MEDIA_LIVE });
  const out = await resolve(ctx("https://cdn.example.com/x/index.m3u8"));
  assert.equal(out.fileName, "星际穿越-4K.ts");
});

test("直播列表：日志标记为直播录制", async () => {
  const { resolve, logs } = load({ body: MEDIA_LIVE });
  await resolve(ctx("https://cdn.example.com/live/index.m3u8"));
  assert.ok(logs.some(([, m]) => m.includes("直播录制")));
});

test("拉播放列表时带上任务 Cookie/Referer/UA", async () => {
  const { resolve, fetched } = load({ body: MEDIA_LIVE });
  await resolve(ctx("https://cdn.example.com/x/index.m3u8"));
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].headers.Cookie, "sid=abc");
  assert.equal(fetched[0].headers.Referer, "https://www.example.com/watch/星际穿越-4K");
  assert.equal(fetched[0].headers["User-Agent"], "UA/1.0");
});

test("响应不是 M3U8（HTML 错误页）→ 放行，返回 null", async () => {
  const { resolve } = load({ body: "<html>403 Forbidden</html>" });
  assert.equal(await resolve(ctx("https://cdn.example.com/x.m3u8")), null);
});

test("HTTP 404 → 放行，返回 null", async () => {
  const { resolve } = load({ body: "", status: 404 });
  assert.equal(await resolve(ctx("https://cdn.example.com/x.m3u8")), null);
});

test("fetch 抛错 → 放行，返回 null（不 fail-closed）", async () => {
  const { resolve } = load({ throwOnFetch: true });
  assert.equal(await resolve(ctx("https://cdn.example.com/x.m3u8")), null);
});

test("非 m3u8 地址直接不管", async () => {
  const { resolve, fetched } = load({ body: MASTER });
  assert.equal(await resolve(ctx("https://example.com/a.mp4")), null);
  assert.equal(fetched.length, 0);
});

test("二段解析（resolverItem 非空）直接放行", async () => {
  const { resolve } = load({ body: MASTER });
  assert.equal(await resolve(ctx("https://cdn.example.com/x.m3u8", { resolverItem: "a" })), null);
});

test("弱页面名（/watch）退到域名作文件名", async () => {
  const { resolve } = load({ body: MEDIA_LIVE });
  const out = await resolve(ctx("https://cdn.example.com/x/index.m3u8", { referrer: "https://www.example.com/watch" }));
  assert.equal(out.fileName, "example.com.ts");
});

test("nameSource=playlist：用播放列表名，弱名忽略", async () => {
  const { resolve } = load({ body: MASTER, settings: { nameSource: "playlist" } });
  const out = await resolve(ctx("https://cdn.example.com/hls/master.m3u8"));
  assert.equal(out.fileName, "星际穿越-4K.mp4"); // master 是弱名 → 退到 referrer
  const out2 = await resolve(ctx("https://cdn.example.com/hls/星际穿越.m3u8"));
  assert.equal(out2.fileName, "星际穿越.mp4");
});

test("nameSource=none：不设置 fileName", async () => {
  const { resolve } = load({ body: MASTER, settings: { nameSource: "none" } });
  const out = await resolve(ctx("https://cdn.example.com/hls/master.m3u8"));
  assert.equal(out.fileName, undefined);
});

test("injectHeaders=false：不下发 extraHeaders", async () => {
  const { resolve } = load({ body: MEDIA_LIVE, settings: { injectHeaders: false } });
  const out = await resolve(ctx("https://cdn.example.com/x/index.m3u8"));
  assert.equal(out.extraHeaders, undefined);
});

test("injectOrigin=true：补 Origin", async () => {
  const { resolve } = load({ body: MEDIA_LIVE, settings: { injectOrigin: true } });
  const out = await resolve(ctx("https://cdn.example.com/x/index.m3u8"));
  assert.equal(out.extraHeaders.Origin, "https://www.example.com");
});

test("文件名清洗：非法字符、连续点、尾部空格", async () => {
  const { resolve } = load({ body: MEDIA_LIVE });
  const out = await resolve(
    ctx("https://cdn.example.com/x/index.m3u8", { referrer: "https://a.com/v/a:b*c?q=1/..%2Fevil%20" }),
  );
  assert.ok(!/[\\/:*?"<>|]/.test(out.fileName), out.fileName);
  assert.ok(!out.fileName.includes(".."), out.fileName);
});

test("相对路径折叠：../ 与 ./", async () => {
  const { resolve } = load({
    body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720\n../v/./720/index.m3u8\n',
  });
  const out = await resolve(ctx("https://cdn.example.com/a/b/master.m3u8"));
  assert.equal(out.variants[0].url, "https://cdn.example.com/a/v/720/index.m3u8");
});

test("SAMPLE-AES：返回正常结果，但日志警告解密可能失败", async () => {
  const { resolve, logs } = load({
    body: '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\n#EXTINF:6,\n1.ts\n#EXT-X-ENDLIST\n',
  });
  const out = await resolve(ctx("https://cdn.example.com/x.m3u8"));
  assert.ok(out.url);
  assert.ok(logs.some(([lvl, m]) => lvl === "warn" && m.includes("不是 AES-128")));
});

/* ------------------------------ 跑起来 ------------------------------ */

let failed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n     ${error.message}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`);
process.exit(failed ? 1 : 0);
