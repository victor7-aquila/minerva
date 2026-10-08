// 앱 폴더의 NOTICE(제3자 라이선스 고지)를 만든다. 런타임 의존성만 대상으로 한다 (루트 AGENTS.md 「라이선스」).
// 사용: 앱 폴더(예: apps/backend)에서 `node ../../scripts/third-party-notices.mjs`
// ★ 의존성을 추가·변경할 때마다 다시 실행하고 결과를 같은 커밋에 넣는다
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 런타임 의존성에 허용하는 라이선스. 이중 라이선스는 이 순서로 하나를 고른다 */
const ALLOWED = [
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'Python-2.0',
];

/** 라이선스 본문의 저작권 표시 줄이다. 본문 문장("copyright notice" 등)은 제외한다 */
const COPYRIGHT_LINE =
  /^\s*(?:(?:portions\s+)?copyright\b(?!\s+(?:notice|owner|license|and|holder|holders|statement|statements|law|protection|\[))|\(c\)\s|©)/i;

const appDir = process.cwd();

/** pnpm이 알려 주는 런타임 의존성 트리를 패키지별 한 줄로 펼친다. */
function listRuntimePackages() {
  const json = execSync('corepack pnpm list --prod --depth Infinity --json', {
    cwd: appDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const packages = new Map();
  // ★ pnpm은 같은 패키지가 다시 나오면 하위 의존성을 생략하기도 한다.
  //   처음 본 자리에 하위 목록이 없을 수 있으므로, 하위 목록이 있는 자리를 만날 때마다 펼친다
  const expanded = new Set();
  const stack = [JSON.parse(json)[0].dependencies ?? {}];
  while (stack.length > 0) {
    for (const [name, info] of Object.entries(stack.pop())) {
      const key = `${name}@${info.version}`;
      if (!packages.has(key)) packages.set(key, { name, version: info.version, dir: info.path });
      if (info.dependencies && !expanded.has(key)) {
        expanded.add(key);
        stack.push(info.dependencies);
      }
    }
  }
  return [...packages.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

/** package.json의 라이선스 표기에서 허용 라이선스 하나를 고른다. 고를 수 없으면 null이다. */
function chooseLicense(raw) {
  const expr = String(raw ?? '').replace(/[()]/g, '').trim();
  if (ALLOWED.includes(expr)) return expr;
  if (/\bAND\b/.test(expr)) return null;
  const options = expr.split(/\s+OR\s+/).map((s) => s.trim());
  return ALLOWED.find((id) => options.includes(id)) ?? null;
}

/** 폴더에서 이름이 패턴에 맞는 첫 파일의 내용을 읽는다. */
function readFirst(dir, pattern) {
  const file = readdirSync(dir)
    .filter((f) => pattern.test(f))
    .sort()[0];
  return file ? readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n').trim() : null;
}

/** 패키지 하나의 고지 정보를 모은다. */
function describe(pkg) {
  const meta = JSON.parse(readFileSync(join(pkg.dir, 'package.json'), 'utf8'));
  // 옛 형식(licenses 배열)은 OR로 잇는다
  const rawLicense =
    (typeof meta.license === 'object' ? meta.license?.type : meta.license) ??
    (Array.isArray(meta.licenses)
      ? meta.licenses.map((l) => (typeof l === 'object' ? l.type : l)).join(' OR ')
      : undefined);
  const license = chooseLicense(rawLicense);
  const text = readFirst(pkg.dir, /^(licen[cs]e|copying)/i);
  const notice = readFirst(pkg.dir, /^notice/i);
  const copyrights = text
    ? [...new Set(text.split('\n').filter((line) => COPYRIGHT_LINE.test(line)).map((l) => l.trim()))]
    : [];
  const author = typeof meta.author === 'object' ? meta.author?.name : meta.author;
  return { ...pkg, rawLicense, license, text, notice, copyrights, author };
}

/** 저작권 줄을 뺀 본문을 비교용으로 정규화한다. */
function bodyOf(text) {
  return text
    .split('\n')
    .filter((line) => !COPYRIGHT_LINE.test(line))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 라이선스 묶음의 대표 전문을 고른다. 가장 많은 패키지가 같은 본문을 쓰는 것이다. */
function representativeText(items) {
  const counts = new Map();
  for (const item of items.filter((i) => i.text)) {
    const body = bodyOf(item.text);
    const entry = counts.get(body) ?? { count: 0, text: item.text };
    entry.count += 1;
    counts.set(body, entry);
  }
  const best = [...counts.values()].sort((a, b) => b.count - a.count)[0];
  if (!best) return null;
  return best.text
    .split('\n')
    .filter((line) => !COPYRIGHT_LINE.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const described = listRuntimePackages().map(describe);
const rejected = described.filter((d) => d.license === null);
if (rejected.length > 0) {
  for (const d of rejected) {
    process.stderr.write(`허용 목록 밖 라이선스: ${d.name}@${d.version} (${d.rawLicense})\n`);
  }
  process.exit(1);
}

const groups = new Map();
for (const d of described) {
  if (!groups.has(d.license)) groups.set(d.license, []);
  groups.get(d.license).push(d);
}
const order = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length);

const appName = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).name;
const lines = [
  `# Third-Party Notices — ${appName}`,
  '',
  '이 앱의 배포물에 들어가는 제3자 패키지(런타임 의존성)의 저작권 표시와 라이선스다. 개발 의존성은 배포물에 들어가지 않아 싣지 않는다.',
  '',
  '이 파일은 `scripts/third-party-notices.mjs`로 만든다. 직접 고치지 않고 의존성이 바뀌면 다시 만든다.',
  '',
  '## 요약',
  '',
  '| 라이선스 | 패키지 수 |',
  '| :--- | ---: |',
  ...order.map((id) => `| ${id} | ${groups.get(id).length} |`),
  '',
];

for (const id of order) {
  const items = groups.get(id);
  lines.push(`## ${id}`, '', '### 패키지와 저작권 표시', '');
  for (const d of items) {
    const chosen = d.rawLicense !== d.license ? ` (원래 표기 \`${d.rawLicense}\` 중 ${d.license} 선택)` : '';
    const holders =
      d.copyrights.length > 0
        ? d.copyrights.join(' / ')
        : `라이선스 파일에 저작권 표시 없음${d.author ? `, 작성자: ${d.author}` : ''}`;
    lines.push(`- \`${d.name}@${d.version}\`${chosen} — ${holders}`);
  }
  const text = representativeText(items);
  lines.push('', '### 라이선스 전문', '', '```text', text ?? `${id} (SPDX: https://spdx.org/licenses/${id}.html)`, '```', '');
  const notices = items.filter((d) => d.notice);
  if (notices.length > 0) {
    lines.push('### NOTICE', '');
    for (const d of notices) {
      lines.push(`#### \`${d.name}@${d.version}\``, '', '```text', d.notice, '```', '');
    }
  }
}

writeFileSync(join(appDir, 'NOTICE'), lines.join('\n'));
process.stdout.write(`NOTICE: 런타임 패키지 ${described.length}개, 라이선스 ${order.length}종\n`);
