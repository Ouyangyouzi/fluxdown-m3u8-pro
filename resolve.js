/*
 * M3U8 超级下载器 Pro — FluxDown 插件版
 * 入口：globalThis.resolve(ctx)（经典脚本，不是 ES module）
 *
 * 这个文件只做四件事：
 *   1. 拉一次播放列表，判断它是主列表（多清晰度）还是媒体列表（分片）；
 *   2. 主列表 → 变成 FluxDown 原生的「画质选择」：variants + defaultVariantIndex；
 *   3. 用网页地址给任务起一个像样的文件名（引擎默认只会拿播放列表名）；
 *   4. 补齐防盗链需要的 Referer / UA，并把独立音轨、AES-128、直播这些情况写进日志。
 *
 * 分段下载、AES-128 解密、EXT-X-MAP 初始化段、合并落盘、断点续传、进度与限速
 * 全部由 FluxDown 引擎负责，插件不重复实现。
 */

var LOG_PREFIX = "m3u8-pro:";

function logInfo(msg) {
  try { flux.logger.info(LOG_PREFIX + " " + msg); } catch (e) { /* 日志失败不影响任务 */ }
}

function logWarn(msg) {
  try { flux.logger.warn(LOG_PREFIX + " " + msg); } catch (e) { /* 同上 */ }
}

/* ------------------------------------------------------------------ *
 * URL / 文件名工具（QuickJS 里没有 URL、URLSearchParams）
 * ------------------------------------------------------------------ */

function urlParts(raw) {
  var m = /^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\/([^\/?#]*)([^?#]*)(\?[^#]*)?/.exec(String(raw || ""));
  if (!m) return null;
  return {
    scheme: String(m[1]).toLowerCase(),
    authority: m[2] || "",
    path: m[3] || "/",
    query: m[4] || ""
  };
}

function originOf(raw) {
  var p = urlParts(raw);
  return p ? p.scheme + "://" + p.authority : "";
}

/* 把 "a/./b/../c" 折成 "a/c"，只处理路径部分，保留查询串。 */
function collapsePath(pathAndQuery) {
  var qs = "";
  var p = String(pathAndQuery || "");
  var qi = p.indexOf("?");
  if (qi >= 0) {
    qs = p.slice(qi);
    p = p.slice(0, qi);
  }
  var segs = p.split("/");
  var out = [];
  for (var i = 0; i < segs.length; i++) {
    var s = segs[i];
    if (s === "." || s === "") {
      if (i === 0) out.push(""); // 保住开头的空段，保证仍然是绝对路径
      continue;
    }
    if (s === "..") {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(s);
  }
  var joined = out.join("/");
  if (joined.charAt(0) !== "/") joined = "/" + joined;
  return joined + qs;
}

/* 相对引用 → 绝对地址（HLS 里的 URI 三种写法：绝对、/开头、同目录相对）。 */
function resolveRef(ref, base) {
  var r = String(ref == null ? "" : ref).trim();
  if (!r) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(r)) return r;
  var bp = urlParts(base);
  if (!bp) return r;
  var origin = bp.scheme + "://" + bp.authority;
  if (r.indexOf("//") === 0) return bp.scheme + ":" + r;
  if (r.charAt(0) === "/") return origin + collapsePath(r);
  var dir = bp.path.slice(0, bp.path.lastIndexOf("/") + 1);
  return origin + collapsePath(dir + r);
}

function decodeSafe(s) {
  try { return decodeURIComponent(s); } catch (e) { return String(s); }
}

function lastSegment(raw) {
  var p = urlParts(raw);
  if (!p) return "";
  var path = p.path;
  var seg = path.slice(path.lastIndexOf("/") + 1);
  return decodeSafe(seg);
}

/* Windows / macOS 都不接受的文件名字符，外加连续的点和首尾点号。 */
function sanitizeName(input) {
  var n = String(input == null ? "" : input);
  n = n.replace(/[\\\/:*?"<>|]/g, "_");
  n = n.replace(/[\u0000-\u001f\u007f]/g, " ");
  n = n.replace(/\.{2,}/g, ".");
  n = n.replace(/\s+/g, " ").trim();
  n = n.replace(/^[.\s]+/, "");
  n = n.replace(/[.\s]+$/, "");
  if (n.length > 120) n = n.slice(0, 120).replace(/[.\s]+$/, "");
  /* Windows 保留设备名，落盘会被拒 */
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(n)) n = "_" + n;
  return n;
}

var WEAK_PAGE_NAMES = /^(index|default|watch|play|player|video|videos|movie|movies|live|home|main)(\.(html?|php|aspx?|jsp))?$/i;

function nameFromReferrer(referrer) {
  if (!referrer) return "";
  var seg = lastSegment(referrer);
  if (!seg || WEAK_PAGE_NAMES.test(seg)) {
    var p = urlParts(referrer);
    if (!p) return "";
    seg = p.authority.replace(/^www\./i, "");
  }
  return sanitizeName(seg);
}

function nameFromPlaylist(url) {
  var seg = lastSegment(url);
  seg = seg.replace(/\.(m3u8?|txt)$/i, "");
  if (!seg || /^(index|master|playlist|manifest|chunklist|prog_index)$/i.test(seg)) return "";
  return sanitizeName(seg);
}

/* ------------------------------------------------------------------ *
 * M3U8 解析
 * ------------------------------------------------------------------ */

var ATTR_RE = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;

function parseAttrs(text) {
  var out = {};
  ATTR_RE.lastIndex = 0;
  var m = ATTR_RE.exec(text);
  while (m) {
    var value = m[2];
    if (value.charAt(0) === "\"") value = value.slice(1, -1);
    out[String(m[1]).toUpperCase()] = value;
    m = ATTR_RE.exec(text);
  }
  return out;
}

function parseIntSafe(value) {
  var n = parseInt(String(value == null ? "" : value), 10);
  return isFinite(n) && n > 0 ? n : 0;
}

/* RESOLUTION=1920x1080 */
function parseResolution(value) {
  var m = /^(\d{1,5})\s*[xX*]\s*(\d{1,5})$/.exec(String(value || "").trim());
  if (!m) return { width: 0, height: 0 };
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

function parsePlaylist(text) {
  var lines = String(text || "").split(/\r?\n/);
  var result = {
    variants: [],
    audioGroups: {},
    media: {
      segments: 0,
      uriLines: 0,
      durationSec: 0,
      encrypted: "",
      hasMap: false,
      live: false,
      ended: false
    }
  };

  var current = null;

  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i];
    var line = raw.replace(/^\uFEFF/, "").trim();
    if (!line) continue;

    if (line.indexOf("#EXT-X-STREAM-INF:") === 0) {
      var attrs = parseAttrs(line.slice(line.indexOf(":") + 1));
      var uri = "";
      for (var j = i + 1; j < lines.length; j++) {
        var next = lines[j].trim();
        if (!next) continue;
        if (next.charAt(0) === "#") {
          if (next.indexOf("#EXT-X-STREAM-INF") === 0) break;
          continue;
        }
        uri = next;
        i = j;
        break;
      }
      if (uri) {
        current = { attrs: attrs, uri: uri };
        result.variants.push(current);
      }
      continue;
    }

    if (line.indexOf("#EXT-X-MEDIA:") === 0) {
      var mAttrs = parseAttrs(line.slice(line.indexOf(":") + 1));
      var type = String(mAttrs.TYPE || "").toUpperCase();
      var groupId = mAttrs["GROUP-ID"] || "";
      if ((type === "AUDIO" || type === "SUBTITLES" || type === "CLOSED-CAPTIONS") && groupId) {
        if (!result.audioGroups[groupId]) result.audioGroups[groupId] = [];
        result.audioGroups[groupId].push({
          type: type,
          name: mAttrs.NAME || "",
          language: mAttrs.LANGUAGE || "",
          uri: mAttrs.URI || "",
          isDefault: String(mAttrs.DEFAULT || "").toUpperCase() === "YES",
          autoselect: String(mAttrs.AUTOSELECT || "").toUpperCase() === "YES",
          channels: mAttrs.CHANNELS || ""
        });
      }
      continue;
    }

    if (line.indexOf("#EXT-X-KEY:") === 0) {
      var kAttrs = parseAttrs(line.slice(line.indexOf(":") + 1));
      var method = String(kAttrs.METHOD || "NONE").toUpperCase();
      if (method !== "NONE" && !result.media.encrypted) result.media.encrypted = method;
      continue;
    }

    if (line.indexOf("#EXT-X-MAP:") === 0) {
      result.media.hasMap = true;
      continue;
    }

    if (line.indexOf("#EXT-X-ENDLIST") === 0) {
      result.media.ended = true;
      result.media.live = false;
      continue;
    }

    if (line.indexOf("#EXTINF:") === 0) {
      var dur = parseFloat(line.slice(8));
      result.media.segments++;
      if (isFinite(dur) && dur > 0) result.media.durationSec += dur;
      continue;
    }

    if (line.charAt(0) === "#") continue;

    /* 裸 URI：媒体列表的分片。正常情况下每条分片都配一个 EXTINF，
       所以这里只计数、不累加 segments，避免把片数算成两倍。 */
    result.media.uriLines++;
  }

  if (result.media.segments === 0 && result.media.uriLines > 0) result.media.segments = result.media.uriLines;
  if (!result.media.ended && result.media.segments > 0) result.media.live = true;
  return result;
}

function shortCodecs(codecs) {
  var c = String(codecs || "");
  if (!c) return "";
  if (c.indexOf(",") >= 0) c = c.split(",")[0];
  return c.trim();
}

function mbpsOf(bandwidth) {
  if (!bandwidth) return "";
  var mbps = bandwidth / 1000000;
  return (mbps >= 10 ? mbps.toFixed(1) : mbps.toFixed(2)) + " Mbps";
}

function pickAudio(groupList, wantType) {
  if (!groupList || !groupList.length) return null;
  var i;
  for (i = 0; i < groupList.length; i++) {
    if (groupList[i].type !== wantType) continue;
    if (groupList[i].isDefault && groupList[i].uri) return groupList[i];
  }
  for (i = 0; i < groupList.length; i++) {
    if (groupList[i].type !== wantType) continue;
    if (groupList[i].uri) return groupList[i];
  }
  return null;
}

function buildVariants(parsed, baseUrl, wantAudio) {
  var list = [];
  for (var i = 0; i < parsed.variants.length; i++) {
    var v = parsed.variants[i];
    var attrs = v.attrs || {};
    var res = parseResolution(attrs.RESOLUTION);
    var bandwidth = parseIntSafe(attrs["AVERAGE-BANDWIDTH"]) || parseIntSafe(attrs.BANDWIDTH);
    var codecs = shortCodecs(attrs.CODECS);
    var labelBits = [];
    labelBits.push(res.height ? res.height + "p" : (attrs.RESOLUTION ? attrs.RESOLUTION : "清晰度未知"));
    if (bandwidth) labelBits.push(mbpsOf(bandwidth));
    if (codecs) labelBits.push(codecs);

    var audio = wantAudio ? pickAudio(parsed.audioGroups[attrs.AUDIO || ""], "AUDIO") : null;

    list.push({
      label: labelBits.join(" · "),
      url: resolveRef(v.uri, baseUrl),
      bandwidth: bandwidth,
      width: res.width,
      height: res.height,
      audioUrl: audio ? resolveRef(audio.uri, baseUrl) : "",
      audioLabel: audio ? (audio.name || audio.language || "") : ""
    });
  }

  /* 码率高者在前：既符合「默认最高」的直觉，也让 index 0 成为 best。 */
  list.sort(function (a, b) {
    if (b.bandwidth !== a.bandwidth) return b.bandwidth - a.bandwidth;
    return b.height - a.height;
  });
  return list;
}

function chooseIndex(list, preference) {
  if (!list.length) return 0;
  var pref = String(preference == null ? "" : preference);
  if (pref === "best" || pref === "" || pref === "null") return 0;
  var target = parseInt(pref, 10);
  if (!isFinite(target) || target <= 0) return 0;

  var bestFit = -1;
  var lowest = -1;
  for (var i = 0; i < list.length; i++) {
    var h = list[i].height;
    if (!h) continue;
    if (h <= target) {
      if (bestFit < 0) bestFit = i;
      else if (h > list[bestFit].height) bestFit = i;
      else if (h === list[bestFit].height && list[i].bandwidth > list[bestFit].bandwidth) bestFit = i;
    }
    if (lowest < 0 || h < list[lowest].height) lowest = i;
  }
  if (bestFit >= 0) return bestFit;
  if (lowest >= 0) return lowest;
  return 0;
}

/* ------------------------------------------------------------------ *
 * 请求头
 * ------------------------------------------------------------------ */

function headerValue(headers, name) {
  var want = name.toLowerCase();
  for (var key in headers) {
    if (!Object.prototype.hasOwnProperty.call(headers, key)) continue;
    if (key.toLowerCase() === want) return key;
  }
  return "";
}

function copyHeaders(source) {
  var out = {};
  if (!source) return out;
  for (var key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    var value = source[key];
    if (value == null) continue;
    out[key] = String(value);
  }
  return out;
}

function withHeader(headers, name, value) {
  if (!value) return;
  if (headerValue(headers, name)) return; /* 不覆盖任务已有的同名头 */
  headers[name] = value;
}

function fetchHeadersFor(ctx) {
  var headers = copyHeaders(ctx.extraHeaders);
  withHeader(headers, "Referer", ctx.referrer || "");
  withHeader(headers, "Origin", ctx.referrer ? originOf(ctx.referrer) : "");
  withHeader(headers, "User-Agent", ctx.userAgent || "");
  /* 拉播放列表本身可能要登录态：引擎不知道我们在插件里发请求，Cookie 得自己带。 */
  withHeader(headers, "Cookie", ctx.cookies || "");
  return headers;
}

function downloadHeadersFor(ctx, settings) {
  if (!settings.injectHeaders) return null;
  var headers = copyHeaders(ctx.extraHeaders);
  withHeader(headers, "Referer", ctx.referrer || "");
  withHeader(headers, "User-Agent", ctx.userAgent || "");
  if (settings.injectOrigin && ctx.referrer) withHeader(headers, "Origin", originOf(ctx.referrer));
  var hasAny = false;
  for (var key in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, key)) hasAny = true;
  }
  return hasAny ? headers : null;
}

/* ------------------------------------------------------------------ *
 * 文件名
 * ------------------------------------------------------------------ */

function extFor(settings, parsed, isMaster) {
  var c = String(settings.container || "auto").toLowerCase();
  if (c === "mp4" || c === "ts" || c === "mkv") return c;
  if (isMaster) return "mp4"; /* 主列表看不到分段，现代 HLS 基本都是 fMP4 */
  return parsed && parsed.media.hasMap ? "mp4" : "ts";
}

function baseNameFor(ctx, settings, parsed) {
  var mode = String(settings.nameSource || "referrer");
  if (mode === "none") return { base: "", weak: true };

  if (mode === "playlist") {
    var fromList = nameFromPlaylist(ctx.url);
    if (fromList) return { base: fromList, weak: false };
    return { base: nameFromReferrer(ctx.referrer), weak: true };
  }

  var fromPage = nameFromReferrer(ctx.referrer);
  if (fromPage) return { base: fromPage, weak: false };
  var fallback = nameFromPlaylist(ctx.url);
  return { base: fallback, weak: !fallback };
}

function buildFileName(ctx, settings, parsed, isMaster) {
  var picked = baseNameFor(ctx, settings, parsed);
  if (!picked.base) return "";
  return picked.base + "." + extFor(settings, parsed, isMaster);
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

async function resolve(ctx) {
  var url = String((ctx && ctx.url) || "");
  if (!url) return null;
  if (ctx.resolverItem) return null; /* 本插件不产出 manifest */
  if (/m3u8/i.test(url) === false) return null;

  var settings = {
    maxHeight: "1080",
    container: "auto",
    nameSource: "referrer",
    injectHeaders: true,
    injectOrigin: false,
    attachAudio: false
  };
  try {
    var live = (typeof flux !== "undefined" && flux && flux.settings) ? flux.settings : null;
    if (live) {
      if (live.maxHeight != null) settings.maxHeight = live.maxHeight;
      if (live.container != null) settings.container = live.container;
      if (live.nameSource != null) settings.nameSource = live.nameSource;
      if (live.injectHeaders != null) settings.injectHeaders = live.injectHeaders;
      if (live.injectOrigin != null) settings.injectOrigin = live.injectOrigin;
      if (live.attachAudio != null) settings.attachAudio = live.attachAudio;
    }
  } catch (e) { /* 设置读不到就用默认值 */ }

  var response = null;
  try {
    response = await flux.fetch({ url: url, headers: fetchHeadersFor(ctx || {}) });
  } catch (error) {
    /* 拿不到播放列表就放行：交给引擎按原地址去试，比直接失败有用。 */
    logWarn("拉取播放列表失败，交回引擎：" + (error && error.message ? error.message : String(error)));
    return null;
  }

  var status = response && response.status ? response.status : 0;
  if (status < 200 || status >= 300) {
    logWarn("播放列表返回 HTTP " + status + "，交回引擎");
    return null;
  }

  var body = String((response && response.body) || "");
  if (body.indexOf("#EXTM3U") < 0) {
    logWarn("响应不像 M3U8（前 60 字：" + body.slice(0, 60).replace(/\s+/g, " ") + "），交回引擎");
    return null;
  }

  var parsed = parsePlaylist(body);
  var headers = downloadHeadersFor(ctx || {}, settings);
  var isMaster = parsed.variants.length > 0;
  var fileName = buildFileName(ctx || {}, settings, parsed, isMaster);

  if (!isMaster) {
    var mediaBits = [];
    mediaBits.push(String(parsed.media.segments) + " 个分片");
    if (parsed.media.durationSec > 0) mediaBits.push("约 " + Math.round(parsed.media.durationSec / 60) + " 分钟");
    mediaBits.push(parsed.media.hasMap ? "fMP4（含 EXT-X-MAP）" : "TS");
    if (parsed.media.encrypted) mediaBits.push("加密 " + parsed.media.encrypted);
    mediaBits.push(parsed.media.live ? "直播录制" : "点播");
    logInfo("媒体列表：" + mediaBits.join(" · ") + (fileName ? " → " + fileName : ""));

    if (parsed.media.encrypted && parsed.media.encrypted !== "AES-128") {
      logWarn("加密方式 " + parsed.media.encrypted + " 不是 AES-128，FluxDown 目前只自动解 AES-128-CBC，可能失败");
    }

    var single = { url: url };
    if (fileName) single.fileName = fileName;
    if (headers) single.extraHeaders = headers;
    return single;
  }

  var variants = buildVariants(parsed, url, !!settings.attachAudio);
  if (!variants.length) {
    logWarn("主列表里没有解析出可用清晰度，交回引擎");
    return null;
  }

  var index = chooseIndex(variants, settings.maxHeight);
  var picked = variants[index];
  var payload = [];
  for (var i = 0; i < variants.length; i++) {
    var item = variants[i];
    var one = {
      label: item.label,
      url: item.url,
      bandwidth: item.bandwidth,
      width: item.width,
      height: item.height,
      container: extFor(settings, parsed, true)
    };
    if (fileName) one.fileName = fileName;
    if (item.audioUrl) one.audioUrl = item.audioUrl;
    payload.push(one);
  }

  var groups = 0;
  for (var groupId in parsed.audioGroups) {
    if (Object.prototype.hasOwnProperty.call(parsed.audioGroups, groupId)) groups++;
  }
  logInfo(
    "主列表：" + variants.length + " 档清晰度 → 默认 " + picked.label +
    "（index " + index + "）" +
    (groups ? "；" + groups + " 个音轨组" : "") +
    (settings.attachAudio ? "，已附加分离音轨" : "") +
    (fileName ? "；文件名 " + fileName : "")
  );

  var result = {
    /* 兜底地址：即使宿主不认识 variants，也能直接下默认档，而不是失败。 */
    url: picked.url,
    variants: payload,
    defaultVariantIndex: index
  };
  if (fileName) result.fileName = fileName;
  if (headers) result.extraHeaders = headers;
  return result;
}
