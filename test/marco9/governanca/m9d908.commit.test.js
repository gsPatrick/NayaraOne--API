'use strict';

// M9-D908 (reabertura da rodada 3): R3-M2 o commit do ensaio vem também do VERSION gravado pela imagem Docker (sem .git e sem GIT_COMMIT o GO continua alcançável);
// R3-L4 o relatório exportado é um arquivo por empresa, e o ensaio de uma empresa não sobrescreve o da outra. Sem banco.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { currentCommit, exportReport, exportPath } = require('../../../src/features/migration-v2/dryrun/dry.export');
const { verify } = require('../../../src/features/migration-v2/dryrun/dry.signature');

const saved = { commit: process.env.GIT_COMMIT, report: process.env.MIGRATION_DRY3_REPORT_PATH, key: process.env.MIGRATION_DRY3_SIGNING_KEY };
const restore = (name, value) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
afterEach(() => { restore('GIT_COMMIT', saved.commit); restore('MIGRATION_DRY3_REPORT_PATH', saved.report); restore('MIGRATION_DRY3_SIGNING_KEY', saved.key); });
const tempFile = (name, content) => { const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm9d908c-')), name); if (content !== undefined) fs.writeFileSync(file, content); return file; };

test('m9d908 R3-M2: sem GIT_COMMIT o commit sai do VERSION da imagem; GIT_COMMIT tem precedência; VERSION "unknown" ou vazio não vale', () => {
  delete process.env.GIT_COMMIT;
  const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  assert.equal(currentCommit({ versionFile: tempFile('VERSION', `${sha}\n`) }), sha);
  process.env.GIT_COMMIT = 'f'.repeat(40);
  assert.equal(currentCommit({ versionFile: tempFile('VERSION', `${sha}\n`) }), 'f'.repeat(40));
  delete process.env.GIT_COMMIT;
  for (const content of ['unknown\n', '\n']) {
    const got = currentCommit({ versionFile: tempFile('VERSION', content) });
    assert.match(got, /^([0-9a-f]{7,64}|unknown)$/, 'cai para o git ou unknown, nunca devolve o vazio nem o texto do VERSION');
  }
});

test('m9d908 R3-M2: o Dockerfile grava o SHA no VERSION que o código lê, e GIT_COMMIT está documentado', () => {
  const root = path.join(__dirname, '..', '..', '..');
  assert.match(fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8'), /echo "\$GIT_SHA" > \/app\/VERSION/);
  assert.match(fs.readFileSync(path.join(root, '.env.example'), 'utf8'), /GIT_COMMIT/);
});

test('m9d908 R3-L4: o ensaio de uma empresa não sobrescreve o relatório da outra; o arquivo-base guarda o último', () => {
  process.env.MIGRATION_DRY3_REPORT_PATH = tempFile('dry3-report.json');
  process.env.MIGRATION_DRY3_SIGNING_KEY = 'chave-de-teste-nao-usar-em-producao';
  const [a, b] = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  exportReport({ id: 'ensaio-a', conclusion: 'APROVADO', criteria: {}, commit: 'abc' }, { companyId: a });
  exportReport({ id: 'ensaio-b', conclusion: 'REPROVADO', criteria: {}, commit: 'abc' }, { companyId: b });
  assert.notEqual(exportPath(a), exportPath(b));
  const fileA = JSON.parse(fs.readFileSync(exportPath(a), 'utf8'));
  const fileB = JSON.parse(fs.readFileSync(exportPath(b), 'utf8'));
  assert.deepEqual([fileA.report_id, fileA.company_id, fileA.conclusion], ['ensaio-a', a, 'APROVADO']);
  assert.deepEqual([fileB.report_id, fileB.company_id, fileB.conclusion], ['ensaio-b', b, 'REPROVADO']);
  assert.equal(verify(fileA).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(exportPath(), 'utf8')).report_id, 'ensaio-b', 'o arquivo-base é o último ensaio do ambiente (fechamento D940)');
});
