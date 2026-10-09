# 앱 폴더의 NOTICE(제3자 라이선스 고지)를 만든다.
# 런타임 의존성만 대상으로 한다 (루트 AGENTS.md 「라이선스」).
# 사용: 앱 폴더(apps/rag-server)에서 `.venv/Scripts/python.exe scripts/third_party_notices.py`
# ★ 의존성을 추가·변경할 때마다 다시 실행하고 결과를 같은 커밋에 넣는다
"""uv.lock의 런타임 의존성에서 NOTICE를 만든다. 표준 라이브러리만 쓴다."""

import re
import subprocess
import sys
from dataclasses import dataclass
from importlib.metadata import Distribution, PackageNotFoundError, distribution
from pathlib import Path

# 런타임 의존성에 허용하는 라이선스. 이중 라이선스는 이 순서로 하나를 고른다
_ALLOWED = [
    "MIT",
    "ISC",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "Apache-2.0",
    "0BSD",
    "Unlicense",
    "CC0-1.0",
    "Python-2.0",
    "PSF-2.0",
]

# ★ 허용 목록 밖이지만 사용자가 승인한 예외다. 패키지 이름 → 승인 사유. 표기는 원래 값을 그대로 쓴다
_APPROVED_EXCEPTIONS = {
    "certifi": "MPL-2.0 — 사용자 승인",
    "tqdm": "MPL-2.0 AND MIT — 사용자 승인",
    "regex": "Apache-2.0 AND CNRI-Python — 사용자 승인",
    "numpy": "Zlib 등 번들 라이선스 포함 — 사용자 승인",
    "torch": "BSL-1.0·LLVM-exception 등 번들 라이선스 포함 — 사용자 승인",
}

# 클래시파이어 표기를 SPDX로 옮긴다. BSD는 본문으로 판정한다 (아래 _detect_bsd)
_CLASSIFIER_TO_SPDX = {
    "MIT License": "MIT",
    "Apache Software License": "Apache-2.0",
    "Python Software Foundation License": "PSF-2.0",
    "ISC License (ISCL)": "ISC",
    "The Unlicense (Unlicense)": "Unlicense",
}

# 레거시 `License` 필드의 표기를 SPDX로 옮긴다. ★ 표기만 바꾼다 — 표에 없는 표기는 원래 값으로
# 남아 허용 목록 밖 판정을 받는다. 정확히 "BSD"는 본문으로 판정한다 (아래 _detect_bsd)
_LEGACY_TO_SPDX = {
    "Apache 2.0 License": "Apache-2.0",
    "Apache License 2.0": "Apache-2.0",
    "Apache 2.0": "Apache-2.0",
    "ISC License": "ISC",
    "3-Clause BSD License": "BSD-3-Clause",
    "BSD 3-Clause": "BSD-3-Clause",
    "New BSD License": "BSD-3-Clause",
    "MIT License": "MIT",
}

# 라이선스 본문의 저작권 표시 줄이다. 본문 문장("copyright notice" 등)은 제외한다
_COPYRIGHT_LINE = re.compile(
    r"^\s*(?:(?:portions\s+)?copyright\b"
    r"(?!\s+(?:notice|owner|license|and|holder|holders|statement|statements|law|protection|\[))"
    r"|\(c\)\s|©)",
    re.IGNORECASE,
)
# ★ 저작권 줄이 자리표시일 뿐인 템플릿형 라이선스만 전문에서 저작권 줄을 뺀다.
# PSF-2.0처럼 저작권 표시가 조항의 일부인 라이선스는 전문을 그대로 싣는다
_TEMPLATED = frozenset({"MIT", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD"})
_LICENSE_FILE = re.compile(r"^(licen[cs]e|copying)", re.IGNORECASE)
_NOTICE_FILE = re.compile(r"^notice", re.IGNORECASE)
_APP_DIR = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class _Package:
    """런타임 의존성 하나의 고지 정보다."""

    name: str
    version: str
    raw_license: str
    license: str | None
    text: str | None
    notice: str | None
    copyrights: tuple[str, ...]
    author: str | None


def _runtime_requirements() -> list[tuple[str, str]]:
    """uv가 알려 주는 런타임 의존성을 (이름, 버전) 목록으로 돌려준다."""
    result = subprocess.run(
        [
            "uv",
            "export",
            "--no-dev",
            "--no-emit-project",
            "--no-hashes",
            "--format",
            "requirements.txt",
        ],
        cwd=_APP_DIR,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    found: dict[str, str] = {}
    for line in result.stdout.splitlines():
        if not line or line[0] in "# \t":
            continue
        spec = line.split(";")[0].strip()
        name, _, version = spec.partition("==")
        if version:
            found[name.strip()] = version.strip()
    return sorted(found.items(), key=lambda item: item[0].lower())


def _read_files(dist: Distribution, pattern: re.Pattern[str]) -> list[tuple[str, str]]:
    """배포의 라이선스 계열 파일 중 이름이 패턴에 맞는 것을 (이름, 내용)으로 읽는다."""
    texts: list[tuple[str, str]] = []
    for file in sorted(dist.files or [], key=lambda f: str(f)):
        # dist-info 바로 아래 또는 licenses/ 아래의 파일만 본다
        in_dist_info = ".dist-info" in file.parts[0]
        if not in_dist_info or not pattern.match(file.name):
            continue
        path = Path(str(file.locate()))
        if path.is_file():
            body = path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n")
            texts.append((file.name, body.strip()))
    return texts


def _pick_text(files: list[tuple[str, str]], chosen: str | None) -> str | None:
    """라이선스 파일이 여럿이면 고른 라이선스 이름이 파일명에 든 것을 우선한다."""
    if not files:
        return None
    if chosen and len(files) > 1:
        # 예: LICENSE-MIT, LICENSE-APACHE 중 MIT 선택
        key = chosen.split("-")[0].lower()
        matched = [body for name, body in files if key in name.lower()]
        if matched:
            return matched[0]
    return "\n\n".join(body for _, body in files)


def _detect_bsd(text: str | None) -> str | None:
    """BSD 본문을 조항 수로 판정한다. 본문이 없으면 추측하지 않는다."""
    if not text:
        return None
    if "Neither the name" in text or "may be used to endorse" in text:
        return "BSD-3-Clause"
    if "Redistributions in binary form" in text:
        return "BSD-2-Clause"
    return None


def _raw_license(dist: Distribution, text: str | None) -> str:
    """License-Expression → License → 클래시파이어 → 본문 순으로 표기를 찾는다."""
    meta = dist.metadata
    expression = meta.get("License-Expression")
    if expression:
        return expression.strip()
    legacy = (meta.get("License") or "").strip()
    if legacy and "\n" not in legacy and len(legacy) <= 60:
        if legacy == "BSD":
            return _detect_bsd(text) or legacy
        return _LEGACY_TO_SPDX.get(legacy, legacy)
    for classifier in meta.get_all("Classifier") or []:
        if not classifier.startswith("License :: "):
            continue
        label = classifier.rsplit(" :: ", 1)[-1]
        if label in _CLASSIFIER_TO_SPDX:
            return _CLASSIFIER_TO_SPDX[label]
        if label == "BSD License":
            return _detect_bsd(text) or "BSD"
    return legacy.splitlines()[0] if legacy else "UNKNOWN"


def _choose_license(raw: str) -> str | None:
    """표기에서 허용 라이선스 하나를 고른다. 고를 수 없으면 None이다."""
    expression = raw.replace("(", "").replace(")", "").strip()
    if expression in _ALLOWED:
        return expression
    if re.search(r"\bAND\b", expression):
        return None
    options = {part.strip() for part in re.split(r"\s+OR\s+", expression)}
    return next((spdx for spdx in _ALLOWED if spdx in options), None)


def _describe(name: str, version: str) -> _Package:
    """패키지 하나의 고지 정보를 모은다."""
    dist = distribution(name)
    files = _read_files(dist, _LICENSE_FILE)
    notices = [body for _, body in _read_files(dist, _NOTICE_FILE)]
    raw = _raw_license(dist, "\n\n".join(body for _, body in files) or None)
    chosen = _choose_license(raw)
    if chosen is None and name.lower() in _APPROVED_EXCEPTIONS:
        chosen = raw  # 승인된 예외는 원래 표기를 묶음 이름으로 쓴다
    text = _pick_text(files, chosen)
    lines = text.split("\n") if text else []
    copyrights = tuple(dict.fromkeys(_copyright_lines(lines)))
    author = dist.metadata.get("Author") or dist.metadata.get("Author-email")
    return _Package(
        name=name,
        version=version,
        raw_license=raw,
        license=chosen,
        text=text,
        notice="\n\n".join(notices) if notices else None,
        copyrights=copyrights,
        author=author,
    )


def _copyright_lines(lines: list[str]) -> list[str]:
    """저작권 표시 줄을 모은다. 쉼표로 끝나 다음 줄로 이어지는 표시는 한 줄로 합친다."""
    found: list[str] = []
    for index, line in enumerate(lines):
        if not _COPYRIGHT_LINE.match(line):
            continue
        holder = line.strip()
        following = lines[index + 1].strip() if index + 1 < len(lines) else ""
        if holder.endswith(",") and following:
            holder = f"{holder} {following}"
        found.append(holder)
    return found


def _body_of(text: str) -> str:
    """저작권 줄을 뺀 본문을 비교용으로 정규화한다."""
    kept = [ln for ln in text.split("\n") if not _COPYRIGHT_LINE.match(ln)]
    return re.sub(r"\s+", " ", "\n".join(kept)).strip()


def _representative_text(key: str, items: list[_Package]) -> str | None:
    """라이선스 묶음의 대표 전문을 고른다. 가장 많은 패키지가 같은 본문을 쓰는 것이다."""
    counts: dict[str, tuple[int, str]] = {}
    for item in items:
        if not item.text:
            continue
        body = _body_of(item.text)
        count, first = counts.get(body, (0, item.text))
        counts[body] = (count + 1, first)
    if not counts:
        return None
    _, best = max(counts.values(), key=lambda entry: entry[0])
    if key not in _TEMPLATED:
        return best.strip()
    kept = [ln for ln in best.split("\n") if not _COPYRIGHT_LINE.match(ln)]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).strip()


def _render(described: list[_Package]) -> str:
    """NOTICE 본문을 만든다."""
    groups: dict[str, list[_Package]] = {}
    for pkg in described:
        groups.setdefault(pkg.license or "", []).append(pkg)
    order = sorted(groups, key=lambda key: -len(groups[key]))  # 안정 정렬 — 같으면 먼저 나온 순
    lines = [
        "# Third-Party Notices — minerva-rag",
        "",
        "이 앱의 배포물에 들어가는 제3자 패키지(런타임 의존성)의 저작권 표시와 라이선스다. "
        "개발 의존성은 배포물에 들어가지 않아 싣지 않는다.",
        "",
        "이 파일은 `scripts/third_party_notices.py`로 만든다. "
        "직접 고치지 않고 의존성이 바뀌면 다시 만든다.",
        "",
        "## 요약",
        "",
        "| 라이선스 | 패키지 수 |",
        "| :--- | ---: |",
        *[f"| {key} | {len(groups[key])} |" for key in order],
        "",
    ]
    for key in order:
        items = groups[key]
        lines += [f"## {key}", "", "### 패키지와 저작권 표시", ""]
        for pkg in items:
            picked = (
                f" (원래 표기 `{pkg.raw_license}` 중 {pkg.license} 선택)"
                if pkg.raw_license != pkg.license
                else ""
            )
            if pkg.copyrights:
                holders = " / ".join(pkg.copyrights)
            else:
                author = f", 작성자: {pkg.author}" if pkg.author else ""
                holders = f"라이선스 파일에 저작권 표시 없음{author}"
            lines.append(f"- `{pkg.name}@{pkg.version}`{picked} — {holders}")
        text = (
            _representative_text(key, items)
            or f"{key} (SPDX: https://spdx.org/licenses/{key}.html)"
        )
        lines += ["", "### 라이선스 전문", "", "```text", text, "```", ""]
        with_notice = [pkg for pkg in items if pkg.notice]
        if with_notice:
            lines += ["### NOTICE", ""]
            for pkg in with_notice:
                lines += [
                    f"#### `{pkg.name}@{pkg.version}`",
                    "",
                    "```text",
                    pkg.notice or "",
                    "```",
                    "",
                ]
    return "\n".join(lines)


def main() -> int:
    """런타임 의존성을 읽어 NOTICE를 쓰고 종료 코드를 돌려준다."""
    described: list[_Package] = []
    missing: list[str] = []
    for name, version in _runtime_requirements():
        try:
            described.append(_describe(name, version))
        except PackageNotFoundError:
            missing.append(f"{name}@{version}")
    if missing:
        # 다른 플랫폼 전용 마커 등으로 설치되지 않은 패키지다. 수동 확인이 필요하다
        for entry in missing:
            sys.stderr.write(f"설치되지 않아 라이선스를 읽을 수 없음: {entry}\n")
        return 1
    rejected = [pkg for pkg in described if pkg.license is None]
    if rejected:
        for pkg in rejected:
            sys.stderr.write(
                f"허용 목록 밖 라이선스: {pkg.name}@{pkg.version} ({pkg.raw_license})\n"
            )
        return 1
    (_APP_DIR / "NOTICE").write_text(_render(described), encoding="utf-8", newline="\n")
    kinds = {pkg.license for pkg in described}
    sys.stdout.write(f"NOTICE: 런타임 패키지 {len(described)}개, 라이선스 {len(kinds)}종\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
