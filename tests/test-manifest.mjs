// 按 FluxDown 文档里列的校验规则做一次「上架级」自检（不含 SDK 的 zip 检查）。
// 用法：node _build/test-manifest.mjs
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const ROOT = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

const TOP_KEYS = new Set([
  "identity", "name", "version", "description", "homepage", "icon", "minAppVersion",
  "resolvers", "subscriptions", "hooks", "interceptors", "auth", "main", "contributes",
  "permissions", "settings",
]);
const PERMISSIONS = new Set([
  "ffmpeg", "ytdlp", "auth", "tasks", "browserRules", "pageScripts",
  "desktop", "background", "intercept", "archive",
]);
const WIDGET_TYPE = {
  text: ["string"], password: ["string"], textarea: ["string"],
  folder: ["string"], select: ["string"], toggle: ["boolean"], number: ["number"],
};
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

check("顶层没有未知键", () => {
  for (const key of Object.keys(manifest)) assert.ok(TOP_KEYS.has(key), `未知顶层键: ${key}`);
});

check("identity 形状", () => {
  assert.match(manifest.identity, /^[a-z0-9_-]+@[a-z0-9_-]+$/);
});

check("name 非空", () => {
  assert.ok(typeof manifest.name === "string" && manifest.name.trim().length > 0);
});

check("version / minAppVersion 是严格三段", () => {
  assert.match(manifest.version, STRICT_SEMVER);
  if (manifest.minAppVersion) assert.match(manifest.minAppVersion, STRICT_SEMVER);
});

check("resolvers 至多一项，且入口与匹配规则合法", () => {
  assert.ok(Array.isArray(manifest.resolvers));
  assert.ok(manifest.resolvers.length <= 1);
  for (const r of manifest.resolvers) {
    assert.ok(Array.isArray(r.match.urls) && r.match.urls.length > 0);
    assert.ok(fs.existsSync(path.join(ROOT, r.entry)), `入口不存在: ${r.entry}`);
    assert.ok(!path.isAbsolute(r.entry) && !r.entry.includes(".."));
    assert.ok(r.timeoutMs === undefined || r.timeoutMs > 0);
    // URL pattern：* 是唯一通配符；不以 * 开头时首段必须是前缀，不以 * 结尾时末段必须是后缀
    for (const p of r.match.urls) {
      assert.ok(!/[?^$(){}[\]\\|+.]/.test(p.replace(/\./g, "")), `pattern 里出现了非通配语法: ${p}`);
    }
  }
});

check("settings：key 唯一、widget 与 type 匹配、default 是字符串且落在选项内", () => {
  const seen = new Set();
  for (const s of manifest.settings || []) {
    assert.ok(typeof s.key === "string" && s.key.length > 0);
    assert.ok(!seen.has(s.key), `重复 key: ${s.key}`);
    seen.add(s.key);
    assert.ok(["string", "number", "boolean"].includes(s.type), `type 非法: ${s.type}`);
    const widget = s.widget || { string: "text", number: "number", boolean: "toggle" }[s.type];
    assert.ok(WIDGET_TYPE[widget], `widget 非法: ${widget}`);
    assert.ok(WIDGET_TYPE[widget].includes(s.type), `widget ${widget} 不允许 type ${s.type}`);
    if (s.default !== undefined) {
      assert.equal(typeof s.default, "string", `default 必须是字符串: ${s.key}`);
      if (s.type === "boolean") assert.ok(["true", "false"].includes(s.default));
      if (s.type === "number") assert.ok(Number.isFinite(Number(s.default)));
    }
    if (widget === "select") {
      assert.ok(Array.isArray(s.options) && s.options.length > 0, `select 需要 options: ${s.key}`);
      const values = s.options.map((o) => o.value);
      for (const o of s.options) {
        assert.ok(typeof o.value === "string" && typeof o.label === "string");
      }
      if (s.default !== undefined) assert.ok(values.includes(s.default), `default 不在 options 里: ${s.key}`);
    }
  }
});

check("permissions 全部已知，且声明与权限一致", () => {
  for (const p of manifest.permissions || []) assert.ok(PERMISSIONS.has(p), `未知权限: ${p}`);
  const perms = new Set(manifest.permissions || []);
  if (manifest.main && manifest.main.background) assert.ok(perms.has("background"));
  if (manifest.contributes && manifest.contributes.sniffRules) assert.ok(perms.has("browserRules"));
  if (manifest.contributes && (manifest.contributes.pageScripts || []).length) assert.ok(perms.has("pageScripts"));
  if (manifest.contributes && manifest.contributes.archive) assert.ok(perms.has("archive"));
  if (manifest.interceptors) assert.ok(perms.has("intercept"));
  if (manifest.auth) assert.ok(perms.has("auth"));
});

check("包内文件体积符合上限（单脚本 < 1 MiB，便于人工审阅）", () => {
  const files = fs.readdirSync(ROOT, { recursive: true }).filter((f) => fs.statSync(path.join(ROOT, f)).isFile());
  for (const f of files) {
    const size = fs.statSync(path.join(ROOT, f)).size;
    assert.ok(size < 1024 * 1024, `${f} 过大: ${size}`);
  }
});

/* 冒烟：入口脚本能在「没有 flux、没有 console」的空上下文里求值（安装时的编译检查）。 */
check("入口脚本通过安装期编译检查（空白上下文，无 flux/console）", async () => {
  const vm = await import("node:vm");
  const code = fs.readFileSync(path.join(ROOT, manifest.resolvers[0].entry), "utf8");
  vm.runInNewContext(code, {}); // 顶层不能碰 flux / console，否则这里会抛
});

let failed = 0;
for (const [name, fn] of checks) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n     ${error.message}`);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exit(failed ? 1 : 0);
