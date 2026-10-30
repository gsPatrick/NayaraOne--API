'use strict';

// M9-D800 — Alicerce da governança (estrutura de pastas, README, eventos, erros e ordem de construção).
// Rodar SEMPRE em banco descartável (nunca no .env remoto):
//   node scripts/withDisposableDb.js --port <55000-55999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//     "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/m9d800.estrutura.test.js"
// Os testes que dependem do cluster descartável (DISPOSABLE_DB=1) ou do seed de dois tenants são PULADOS com motivo explícito
// fora dele; os estáticos rodam em qualquer lugar.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  API_ROOT, GOV_DIR, DEMANDAS_DIR, EXPECTED_MODULES, EVENTS_7, README_TITLES, listJsFiles,
} = require('./helpers/m9d800Env');


test('m9d800 estrutura de pastas igual ao livro', () => {
  const entries = fs.readdirSync(GOV_DIR, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  assert.deepEqual(dirs, EXPECTED_MODULES, 'core-governance deve ter exatamente as 8 subpastas do livro');
  for (const mod of EXPECTED_MODULES) {
    const files = fs.readdirSync(path.join(GOV_DIR, mod));
    for (const required of ['index.js', `${mod}.routes.js`, `${mod}.controller.js`, `${mod}.service.js`, 'README.md']) {
      assert.ok(files.includes(required), `${mod} sem ${required}`);
    }
    const mod_ = require(path.join(GOV_DIR, mod));
    assert.ok(mod_.router && typeof mod_.router === 'function', `${mod}/index.js deve exportar router`);
    assert.ok(mod_.service && typeof mod_.service === 'object', `${mod}/index.js deve exportar service`);
    assert.ok(Array.isArray(mod_.events), `${mod}/index.js deve exportar events`);
  }
});

test('m9d800 cada README tem os 9 títulos de seção', () => {
  for (const mod of EXPECTED_MODULES) {
    const text = fs.readFileSync(path.join(GOV_DIR, mod, 'README.md'), 'utf8');
    const headings = text.split('\n').filter((l) => /^##\s/.test(l)).map((l) => l.replace(/^##\s+(\d+\.\s*)?/, '').trim());
    assert.deepEqual(headings.slice(0, 9), README_TITLES, `${mod}/README.md: 9 títulos fixos, na ordem`);
    for (const title of README_TITLES) {
      const body = text.split(new RegExp(`^##\\s+(?:\\d+\\.\\s*)?${title.replace(/[()]/g, '\\$&')}\\s*$`, 'm'))[1] || '';
      assert.ok(body.split(/^##\s/m)[0].trim().length > 10, `${mod}/README.md: seção "${title}" vazia`);
    }
  }
});

test('m9d800 catálogo de eventos tem exatamente os 7 tipos do livro', async () => {
  const events = require('../src/features/core-governance/governance.events');
  assert.deepEqual([...events.GOVERNANCE_EVENT_TYPES].sort(), [...EVENTS_7].sort());
  const owned = EXPECTED_MODULES.flatMap((mod) => require(path.join(GOV_DIR, mod)).events);
  assert.deepEqual([...owned].sort(), [...EVENTS_7].sort(), 'cada evento pertence a exatamente um módulo');
  await assert.rejects(
    () => events.publishGovernanceEvent({ groupId: 'g', companyId: 'c', aggregateType: 'X', aggregateId: 'a', eventType: 'outro.evento', idempotencyKey: 'k' }, {}),
    (err) => err.code === 'GOV_EVENT_UNKNOWN' && err.statusCode === 500
  );
  await assert.rejects(
    () => events.publishGovernanceEvent({ groupId: 'g', companyId: 'c', aggregateType: 'X', aggregateId: 'a', eventType: 'calendar.item.updated' }, {}),
    (err) => err.code === 'GOV_EVENT_IDEMPOTENCY_REQUIRED'
  );
  // Nenhum arquivo do bloco publica evento fora do catálogo: todo eventType literal está entre os 7.
  for (const file of listJsFiles(GOV_DIR)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/eventType:\s*'([^']+)'/g)) assert.ok(EVENTS_7.includes(m[1]), `${path.relative(API_ROOT, file)}: evento fora do livro ${m[1]}`);
  }
});

test('m9d800 corpo de erro de governança tem formato único com error.traceId e código com prefixo GOV_ (exceto a lista fechada)', async () => {
  const errors = require('../src/features/core-governance/governance.errors');
  assert.deepEqual(errors.DEFAULT_PREFIX_EXCEPTIONS, ['PERMISSION_DENIED', 'MISSING_ACCESS_TOKEN', 'MFA_STEP_UP_REQUIRED', 'MFA_REQUIRED_NOT_ENABLED', 'INTERNAL_ERROR', 'VALIDATION_ERROR']);
  const nf = errors.govNotFound();
  assert.equal(nf.statusCode, 404);
  assert.equal(nf.code, 'GOV_NOT_FOUND');
  assert.equal(nf.message, 'Registro não encontrado.');
  assert.throws(() => errors.govError(400, 'CODIGO_SEM_PREFIXO', 'x'), /prefixo GOV_/);
  assert.equal(errors.govError(403, 'PERMISSION_DENIED', 'x').code, 'PERMISSION_DENIED');

  // Varredura estática SOMENTE em core-governance: todo código de erro é GOV_ ou da lista fechada.
  const allowed = new Set(errors.DEFAULT_PREFIX_EXCEPTIONS);
  const offenders = [];
  for (const file of listJsFiles(GOV_DIR)) {
    // *.constants.js guarda enumerações de domínio (ex.: tipos de origem do calendário), não códigos de erro.
    if (file.endsWith('governance.errors.js') || file.endsWith('.constants.js')) continue;
    const text = fs.readFileSync(file, 'utf8');
    // Só o que é código de erro: 2º argumento de govError(status, 'CODIGO', ...) e propriedades `code: 'CODIGO'`; enumerações de domínio (tipos, ações, formatos) não são códigos.
    for (const m of text.matchAll(/(?:govError\(\s*\d+\s*,|\bcode\s*(?:[:=]|===)\s*)\s*['"`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"`]/g)) {
      if (!m[1].startsWith('GOV_') && !allowed.has(m[1])) offenders.push(`${path.relative(API_ROOT, file)}: ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, [], 'códigos sem prefixo GOV_ fora da lista fechada');
});

test('m9d800 a tabela de ordem 3.5 coincide com o campo Dependências das demandas do bloco', () => {
  // Dependências esperadas, transcritas da tabela 3.5 (cada passo: ordem interna; a primeira depende das últimas do passo anterior).
  const esperado = {
    D801: ['D800'], D803: ['D801'], D802: ['D801', 'D803'],
    D804: ['D802'], D807: ['D804'], D805: ['D804', 'D807'], D806: ['D805'], D808: ['D806', 'D807'],
    D810: ['D806', 'D808'], D811: ['D810'],
    D820: ['D811'], D821: ['D820'], D822: ['D821'], D823: ['D821'], D824: ['D821'], D825: ['D821'],
    D830: ['D822', 'D823', 'D824', 'D825'], D831: ['D830'], D834: ['D831'], D832: ['D831', 'D834'], D833: ['D832'],
    D840: ['D833'], D841: ['D840'], D843: ['D840'], D842: ['D840', 'D843'], D844: ['D841', 'D843'],
    D850: ['D842', 'D843', 'D844'], D851: ['D850'], D852: ['D850', 'D843'],
    D860: ['D851', 'D852'], D861: ['D860'], D862: ['D860'], D863: ['D861', 'D862'],
    D870: ['D863'], D871: ['D870'], D872: ['D870'],
    D890: ['D802', 'D803', 'D808', 'D811', 'D822', 'D824', 'D825', 'D832', 'D834', 'D840', 'D842', 'D850', 'D851', 'D861', 'D863', 'D871', 'D872'],
    D891: ['D890'], D809: ['D891'],
  };
  const files = fs.readdirSync(DEMANDAS_DIR).filter((f) => /^M9-D\d{3}-.*\.md$/.test(f));
  const deps = {};
  for (const f of files) {
    const id = f.slice(3, 7);
    const line = fs.readFileSync(path.join(DEMANDAS_DIR, f), 'utf8').split('\n').find((l) => l.startsWith('| Dependências'));
    deps[id] = line ? [...line.matchAll(/M9-(D\d{3})/g)].map((m) => m[1]).sort() : null;
  }
  for (const [id, want] of Object.entries(esperado)) {
    assert.ok(deps[id], `demanda ${id} sem campo Dependências`);
    assert.deepEqual(deps[id], [...want].sort(), `Dependências de ${id} divergem da tabela 3.5`);
  }
  // Bloco F: a primeira demanda de cada trilha chega a D891 (F1, F2) ou não depende de ninguém (F4); D940 fecha as trilhas.
  const reaches = (from, target, seen = new Set()) => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (deps[from] || []).some((d) => reaches(d, target, seen));
  };
  assert.ok(reaches('D906', 'D891'), 'F1 começa depois de D891');
  assert.ok(reaches('D911', 'D891'), 'F2 começa depois de D891');
  assert.ok(reaches('D914', 'D901') && reaches('D914', 'D810'), 'F3 (D914) depende da migração e do lineage');
  assert.deepEqual(deps.D930, [], 'F4 não depende de ninguém');
  for (const id of ['D908', 'D910', 'D915', 'D920', 'D932']) assert.ok(deps.D940.includes(id), `D940 deve depender de ${id}`);
});
