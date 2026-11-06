"""把插件打包成 .fxplug（= 插件目录的 zip，manifest.json 在根）。

用法：python scripts/pack.py
产物：dist/<identity>-<version>.fxplug
"""

import hashlib
import json
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
SKIP = {"dist", ".git", ".github", "scripts", "tests", "node_modules", "__pycache__", ".gitignore"}


def plugin_files() -> list[pathlib.Path]:
    """插件目录里真正要进包的文件（排除开发用目录）。"""
    out = []
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(ROOT)
        if rel.parts[0] in SKIP:
            continue
        out.append(path)
    return out


def main() -> None:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    name = f"{manifest['identity'].replace('@', '-')}-{manifest['version']}.fxplug"
    out = DIST / name
    DIST.mkdir(exist_ok=True)

    files = plugin_files()
    # 固定时间戳：同样的输入打出同样的哈希，便于自己做内容寻址比对。
    stamp = (1980, 1, 1, 0, 0, 0)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in files:
            arcname = path.relative_to(ROOT).as_posix()
            assert "\\" not in arcname, f"条目里有反斜杠: {arcname}"
            info = zipfile.ZipInfo(arcname, date_time=stamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, path.read_bytes())

    data = out.read_bytes()
    digest = hashlib.sha256(data).hexdigest()

    # 回读校验：条目名与源文件一一对应、字节一致、CRC 通过。
    with zipfile.ZipFile(out) as zf:
        bad = zf.testzip()
        assert bad is None, f"CRC 校验失败: {bad}"
        entries = zf.namelist()
        assert entries == [p.relative_to(ROOT).as_posix() for p in files], "条目列表与源文件不一致"
        for entry in entries:
            assert zf.read(entry) == (ROOT / entry).read_bytes(), f"内容不一致: {entry}"
        unpacked = sum(i.file_size for i in zf.infolist())

    print(f"打包完成: {out}")
    print(f"条目: {len(entries)} 个 / 压缩包 {len(data):,} B / 解压后 {unpacked:,} B")
    for entry in entries:
        print(f"  - {entry}")
    print(f"sha256: {digest}")


if __name__ == "__main__":
    main()
