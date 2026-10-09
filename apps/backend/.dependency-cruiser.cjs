// 모듈 의존 방향 검사. 규칙의 근거는 apps/backend/ARCHITECT.md 「의존 규칙」이다.
// ★ ARCHITECT.md의 의존 다이어그램이 바뀌면 ALLOWED도 함께 고친다
// 모듈 규칙은 src 안의 모듈 사이에만 적용된다

/** 모듈별로 import해도 되는 다른 모듈 (자기 자신은 항상 허용) */
const ALLOWED = {
  documents: ['assets', 'indexing', 'logs', 'rag', 'storage', 'common'],
  assets: ['rag', 'logs', 'storage', 'common'],
  indexing: ['rag', 'storage', 'common'],
  search: ['assets', 'documents', 'rag', 'common'],
  evaluation: ['documents', 'rag', 'storage', 'common'],
  logs: ['storage', 'common'],
  storage: ['common'],
  rag: ['common'],
  common: [],
  // api는 앱 조립(AppModule)을 위해 모든 모듈을 import한다
  api: [
    'documents',
    'assets',
    'indexing',
    'search',
    'evaluation',
    'logs',
    'storage',
    'rag',
    'common',
  ],
};

const MODULES = Object.keys(ALLOWED);

const moduleRules = MODULES.map((from) => {
  const forbidden = MODULES.filter((to) => to !== from && !ALLOWED[from].includes(to));
  return {
    name: `${from}-allowed-deps`,
    comment: `${from} 모듈은 ARCHITECT.md 「의존 규칙」에 없는 모듈(${forbidden.join(', ')})을 import하지 않는다`,
    severity: 'error',
    from: { path: `^src/${from}/` },
    to: { path: `^src/(${forbidden.join('|')})/` },
  };
}).filter((rule) => !rule.to.path.endsWith('()/'));

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    ...moduleRules,
    {
      name: 'no-circular',
      comment: '단위 사이 의존에 순환이 없어야 한다',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-qdrant',
      comment: 'Backend는 Qdrant에 접속하지 않는다 (AGENTS.md)',
      severity: 'error',
      from: {},
      to: { path: '(^|/)node_modules/@qdrant/' },
    },
    {
      name: 'http-client-only-in-rag',
      comment:
        'RAG Server 호출은 rag 모듈을 거친다. 다른 모듈은 HTTP 클라이언트를 import하지 않는다',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/rag/' },
      to: { path: '(^|/)node_modules/(axios|undici|got|node-fetch|ky)/' },
    },
    {
      name: 'no-feature-imports-main',
      comment: '앱 진입점(src/main.ts)은 다른 파일이 import하지 않는다',
      severity: 'error',
      from: { pathNot: '^src/main\\.ts$' },
      to: { path: '^src/main\\.ts$' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.spec\\.ts$' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
  },
};
