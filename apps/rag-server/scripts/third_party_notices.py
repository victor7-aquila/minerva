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
    # ★ "(c)"는 연도 또는 저작권자 이름이 뒤따를 때만 저작권 표시로 본다.
    #   Apache-2.0 전문 4(c) 조항("(c) You must retain ...")을 거르기 위해 You·If·The 시작은 뺀다
    r"|\(c\)\s+(?:(?:19|20)\d{2}\b|(?!(?:you|if|the)\b)(?-i:[A-Z]))|©)",
    re.IGNORECASE,
)
# ★ 저작권 줄이 자리표시일 뿐인 템플릿형 라이선스만 전문에서 저작권 줄을 뺀다.
# PSF-2.0처럼 저작권 표시가 조항의 일부인 라이선스는 전문을 그대로 싣는다
_TEMPLATED = frozenset({"MIT", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD"})
_LICENSE_FILE = re.compile(r"^(licen[cs]e|copying)", re.IGNORECASE)
_NOTICE_FILE = re.compile(r"^notice", re.IGNORECASE)
_APP_DIR = Path(__file__).resolve().parents[1]

# ── GPU 배포용 선택 설치 ───────────────────────────────────

# GPU 선택 설치 명령의 uv 그룹 인자다 (pyproject.toml의 cpu·gpu 그룹)
_GPU_GROUPS = ("--group", "gpu", "--no-group", "cpu")
_GPU_COMMAND = "uv sync --group gpu --no-group cpu"

# NVIDIA 독점 라이선스 이름 → 전문 URL
_NVIDIA_LICENSES = {
    "NVIDIA CUDA Toolkit EULA": "https://docs.nvidia.com/cuda/eula/index.html",
    "NVIDIA cuDNN SLA": "https://docs.nvidia.com/deeplearning/cudnn/latest/reference/eula.html",
    "NVIDIA cuSPARSELt SLA": "https://docs.nvidia.com/cuda/cusparselt/license.html",
}

_NVIDIA_HOLDER = "NVIDIA Corporation (라이선스 파일에 저작권 표시 없음)"
_NVIDIA_APACHE = "Copyright (c) 2024-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved."

_NCCL_TEXT = """Copyright (c) 2015-2020, NVIDIA CORPORATION. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
 * Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
 * Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.
 * Neither the name of NVIDIA CORPORATION, Lawrence Berkeley National
   Laboratory, the U.S. Department of Energy, nor the names of their
   contributors may be used to endorse or promote products derived
   from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS ``AS IS'' AND ANY
EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL THE COPYRIGHT OWNER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY
OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

The U.S. Department of Energy funded the development of this software
under subcontract 7078610 with Lawrence Berkeley National Laboratory.

This code also includes files from the NVIDIA Tools Extension SDK project.
See https://github.com/NVIDIA/NVTX for more information and license details."""

_ZLIB_TEXT = """This software is provided 'as-is', without any express or implied
warranty.  In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution."""


@dataclass(frozen=True)
class _GpuPackage:
    """GPU 선택 설치로만 들어오는 패키지 하나의 확인 결과다."""

    version: str  # 라이선스를 확인한 버전
    license: str
    holders: str
    note: str = ""
    text: str | None = None  # 위 기본 설치 절에 같은 전문이 없을 때만 싣는다


# ★ GPU 선택 설치로만 들어오는 패키지는 사람이 확인한 결과를 여기에 적는다. Linux 전용 휠은
#   Windows 개발 환경에 설치되지 않아 메타데이터를 읽을 수 없고, PyPI 표기가 휠 안의 라이선스
#   파일과 다른 패키지(nccl·nvtx)가 있다. lock의 버전이 바뀌면 스크립트가 멈추므로, 휠의
#   라이선스 파일을 다시 확인한 뒤 버전을 고친다
_GPU_PACKAGES = {
    "torch": _GpuPackage(
        "2.14.1+cu130",
        "Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause AND BSD-3-Clause "
        "AND BSL-1.0 AND MIT",
        "기본 설치의 torch와 같은 라이선스 파일·저작권 표시",
        "Windows 휠은 CUDA 라이브러리를 휠 안에 담는다 (아래 「휠에 포함된 라이브러리」)",
    ),
    "triton": _GpuPackage(
        "3.8.0",
        "MIT",
        "Copyright 2018-2020 Philippe Tillet / Copyright 2020-2022 OpenAI",
        "Linux 전용. NVIDIA 도구를 휠 안에 담는다 (아래 「휠에 포함된 라이브러리」)",
    ),
    "cuda-bindings": _GpuPackage("13.4.3", "Apache-2.0", _NVIDIA_APACHE, "Linux 전용"),
    "cuda-pathfinder": _GpuPackage("1.8.3", "Apache-2.0", _NVIDIA_APACHE, "Linux 전용"),
    "nvidia-nvtx": _GpuPackage(
        "13.0.85",
        "Apache-2.0",
        _NVIDIA_HOLDER,
        "Linux 전용. PyPI 클래시파이어는 Other/Proprietary이나 휠의 라이선스 파일은 Apache-2.0",
    ),
    "nvidia-nccl-cu13": _GpuPackage(
        "2.30.7",
        "BSD-3-Clause",
        "Copyright (c) 2015-2020, NVIDIA CORPORATION. All rights reserved.",
        "Linux 전용. PyPI 표기는 LicenseRef-NVIDIA-Proprietary이나 "
        "휠의 라이선스 파일은 BSD-3-Clause",
        _NCCL_TEXT,
    ),
    "cuda-toolkit": _GpuPackage(
        "13.0.3.0",
        "NVIDIA CUDA Toolkit EULA",
        "NVIDIA Corporation (메타데이터만 있고 라이선스 표기 없음)",
        "Linux 전용. 코드 없이 아래 nvidia-* CUDA 패키지만 끌어오는 메타패키지",
    ),
    "nvidia-cublas": _GpuPackage("13.1.1.3", "NVIDIA CUDA Toolkit EULA", _NVIDIA_HOLDER),
    "nvidia-cuda-cupti": _GpuPackage("13.0.85", "NVIDIA CUDA Toolkit EULA", _NVIDIA_HOLDER),
    "nvidia-cuda-nvrtc": _GpuPackage("13.0.88", "NVIDIA CUDA Toolkit EULA", _NVIDIA_HOLDER),
    "nvidia-cuda-runtime": _GpuPackage("13.0.96", "NVIDIA CUDA Toolkit EULA", _NVIDIA_HOLDER),
    "nvidia-cufft": _GpuPackage("12.0.0.61", "NVIDIA CUDA Toolkit EULA", _NVIDIA_HOLDER),
    "nvidia-cufile": _GpuPackage("1.15.1.6", "NVIDIA CUDA Toolkit EULA", _NVIDIA_HOLDER),
    "nvidia-curand": _GpuPackage("10.4.0.35", "NVIDIA CUDA Toolkit EULA", _NVIDIA_HOLDER),
    "nvidia-cusolver": _GpuPackage("12.0.4.66", "NVIDIA CUDA Toolkit EULA", _NVIDIA_HOLDER),
    "nvidia-cusparse": _GpuPackage("12.6.3.3", "NVIDIA CUDA Toolkit EULA", _NVIDIA_HOLDER),
    "nvidia-nvjitlink": _GpuPackage("13.4.92", "NVIDIA CUDA Toolkit EULA", _NVIDIA_HOLDER),
    "nvidia-nvshmem-cu13": _GpuPackage("3.4.5", "NVIDIA CUDA Toolkit EULA", _NVIDIA_HOLDER),
    "nvidia-cudnn-cu13": _GpuPackage("9.24.0.43", "NVIDIA cuDNN SLA", _NVIDIA_HOLDER),
    "nvidia-cusparselt-cu13": _GpuPackage("0.8.1", "NVIDIA cuSPARSELt SLA", _NVIDIA_HOLDER),
}

# 휠 안에 담긴 라이브러리: (휠, 파일, 라이선스, 저작권 표시)
_GPU_BUNDLED = [
    (
        "torch@2.14.1+cu130 (Windows)",
        "cudart64_13, cublas64_13, cublasLt64_13, cufft64_12, cufftw64_12, curand64_10, "
        "cusolver64_12, cusolverMg64_12, cusparse64_12, nvrtc64_130_0, nvrtc-builtins64_130, "
        "nvJitLink_130_0, cupti64_2025.3.0, nvperf_host, nvToolsExt64_1 (.dll)",
        "NVIDIA CUDA Toolkit EULA",
        "Copyright © NVIDIA Corporation 1993 - 2025",
    ),
    (
        "torch@2.14.1+cu130 (Windows)",
        "cudnn64_9 외 cudnn_*64_9 (.dll)",
        "NVIDIA cuDNN SLA",
        "Copyright (c) 2014-2023 NVIDIA CORPORATION & AFFILIATES. All rights reserved.",
    ),
    (
        "torch@2.14.1+cu130 (Windows)",
        "zlibwapi.dll (zlib 1.2.3)",
        "Zlib",
        "(C) 1995-2003 Jean-loup Gailly & Mark Adler",
    ),
    (
        "triton@3.8.0 (Linux)",
        "triton/backends/nvidia의 ptxas, ptxas-blackwell, cuobjdump, nvdisasm, "
        "libdevice.10.bc, cuda.h",
        "NVIDIA CUDA Toolkit EULA",
        _NVIDIA_HOLDER,
    ),
]


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


def _runtime_requirements(*groups: str) -> list[tuple[str, str]]:
    """uv가 알려 주는 런타임 의존성을 (이름, 버전) 목록으로 돌려준다."""
    # groups는 uv export에 더할 그룹 인자다 (예: GPU 선택 설치)
    result = subprocess.run(
        [
            "uv",
            "export",
            "--no-dev",
            *groups,
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
        "개발 의존성은 배포물에 들어가지 않아 싣지 않는다. "
        "GPU 배포용 선택 설치에서만 들어오는 패키지는 "
        "맨 끝 「GPU 배포용 선택 설치」 절에 따로 적는다.",
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


def _gpu_only() -> list[tuple[str, str]]:
    """GPU 선택 설치에만 들어오는 런타임 의존성을 (이름, 버전) 목록으로 돌려준다."""
    base = set(_runtime_requirements())
    gpu = set(_runtime_requirements(*_GPU_GROUPS))
    return sorted(gpu - base, key=lambda item: item[0].lower())


def _gpu_problems(gpu_only: list[tuple[str, str]], default_licenses: set[str]) -> list[str]:
    """GPU 패키지의 확인 결과가 lock과 어긋나는 곳을 돌려준다."""
    problems = [
        f"GPU 선택 설치 패키지의 라이선스 확인 결과가 없거나 버전이 다름: {name}@{version}"
        for name, version in gpu_only
        if name not in _GPU_PACKAGES or _GPU_PACKAGES[name].version != version
    ]
    stale = set(_GPU_PACKAGES) - {name for name, _ in gpu_only}
    problems += [f"GPU 선택 설치에 더 이상 들어오지 않음: {name}" for name in sorted(stale)]
    # 허용 라이선스는 전문을 직접 싣거나 위 기본 설치 절의 전문을 가리킨다
    no_text = [
        name
        for name, _ in gpu_only
        if name in _GPU_PACKAGES
        and _GPU_PACKAGES[name].license not in _NVIDIA_LICENSES
        and _GPU_PACKAGES[name].text is None
        and _GPU_PACKAGES[name].license not in default_licenses
    ]
    problems += [f"GPU 선택 설치 패키지의 라이선스 전문을 찾을 수 없음: {name}" for name in no_text]
    return problems


def _gpu_line(name: str) -> str:
    """GPU 패키지 한 줄을 만든다."""
    entry = _GPU_PACKAGES[name]
    note = f" — {entry.note}" if entry.note else ""
    return f"- `{name}@{entry.version}` — {entry.license} — {entry.holders}{note}"


def _render_gpu(gpu_only: list[tuple[str, str]]) -> str:
    """GPU 배포용 선택 설치 절을 만든다."""
    names = [name for name, _ in gpu_only]
    nvidia = [name for name in names if _GPU_PACKAGES[name].license in _NVIDIA_LICENSES]
    allowed = [name for name in names if name not in nvidia]
    with_text = [name for name in allowed if _GPU_PACKAGES[name].text]
    lines = [
        "## GPU 배포용 선택 설치",
        "",
        f"`{_GPU_COMMAND}`로 설치할 때만 들어오는 패키지다. "
        "기본 설치(`uv sync`)에는 들어오지 않아 위 절과 요약에 세지 않는다. "
        "CUDA 런타임(NVIDIA 독점 라이선스)은 이 선택 설치에만 허용한 사용자 승인 예외다 "
        "(저장소 루트 `AGENTS.md` 「라이선스」).",
        "",
        "Windows에서는 torch만 CUDA 휠로 바뀌고 CUDA 라이브러리는 휠 안에 담겨 온다. "
        "Linux에서는 torch가 아래 cuda-*·nvidia-*·triton 패키지를 끌어온다.",
        "",
        "### NVIDIA 라이선스 전문",
        "",
        "| 라이선스 | 전문 |",
        "| :--- | :--- |",
        *[f"| {key} | {url} |" for key, url in _NVIDIA_LICENSES.items()],
        "",
        "### NVIDIA 독점 라이선스 패키지",
        "",
        *[_gpu_line(name) for name in nvidia],
        "",
        "### 허용 라이선스 패키지",
        "",
        "전문을 따로 싣지 않은 패키지는 위 같은 이름의 라이선스 절 전문을 따른다.",
        "",
        *[_gpu_line(name) for name in allowed],
        "",
    ]
    for name in with_text:
        entry = _GPU_PACKAGES[name]
        lines += [f"#### `{name}@{entry.version}` 라이선스 전문", ""]
        lines += ["```text", entry.text or "", "```", ""]
    lines += ["### 휠에 포함된 라이브러리", ""]
    lines += [
        f"- `{wheel}` — {files} — {key} — {holders}" for wheel, files, key, holders in _GPU_BUNDLED
    ]
    lines += ["", "#### Zlib 전문", "", "```text", _ZLIB_TEXT, "```", ""]
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
    kinds = {pkg.license for pkg in described}
    gpu_only = _gpu_only()
    problems = _gpu_problems(gpu_only, {kind for kind in kinds if kind})
    if problems:
        # ★ 휠의 라이선스 파일을 다시 확인하고 _GPU_PACKAGES를 고친다
        for problem in problems:
            sys.stderr.write(f"{problem}\n")
        return 1
    body = f"{_render(described)}\n{_render_gpu(gpu_only)}"
    (_APP_DIR / "NOTICE").write_text(body, encoding="utf-8", newline="\n")
    sys.stdout.write(
        f"NOTICE: 런타임 패키지 {len(described)}개, 라이선스 {len(kinds)}종, "
        f"GPU 선택 설치 전용 패키지 {len(gpu_only)}개\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
