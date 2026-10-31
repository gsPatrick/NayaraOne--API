'use strict';

// M9-D940 — o fechamento do bloco F: caminho feliz, erro de leitura (exit 2) e DRY3 lido do arquivo exportado.
// Banco descartável: node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c \
//   "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/governanca/m9d940.*.test.js"
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DISPOSABLE, SKIP_DISPOSABLE } = require('../../m9d801.helpers');
const kit = require('../_helpers/m9d940Fixtures');

const skip = () => (DISPOSABLE ? false : SKIP_DISPOSABLE);

test('m9d940 DoD do bloco F verde com as cinco provas OK', { skip: skip() }, () => {
  const amb = kit.ambiente();
  const r = kit.fechar(amb);
  assert.equal(r.status, 0, r.out);
  for (const nome of ['Migração v2 DRY3', 'governance registry', 'lineage crítico', 'DLP', 'manifest documental', 'testes do livro do bloco F']) assert.match(kit.linha(r, nome), /^OK /, `${nome}\n${r.out}`);
  assert.doesNotMatch(r.out, /FALHA|GOV_DOD_F/);
  const registro = JSON.parse(fs.readFileSync(amb.saida, 'utf8'));
  assert.equal(registro.exit_code, 0);
  assert.equal(registro.resultado, 'VERDE');
  assert.equal(registro.itens.length, 6);
  assert.ok(registro.itens.every((i) => i.resultado === 'OK'));
  assert.match(registro.commit, /^[0-9a-f]{40}$/);
  assert.ok(Math.abs(Date.now() - Date.parse(registro.generated_at)) < 10 * 60 * 1000, 'data da execução registrada');
  assert.match(r.stdout, /Fechamento do bloco F: VERDE/);
});

test('m9d940 suíte com teste pulado no banco descartável reprova o item', { skip: skip() }, () => {
  const amb = kit.ambiente();
  amb.cfg.dlp.suites = [kit.suiteMinima(amb.dir, 'pulado.suite.test.js', "test('pulado', { skip: 'depois' }, () => {});")];
  amb.salvar();
  const r = kit.fechar(amb);
  assert.equal(r.status, 1, r.out);
  assert.match(kit.linha(r, 'DLP'), /^FALHA DLP: suíte: 1 teste\(s\) pulado\(s\)/);
  assert.match(r.stderr, /GOV_DOD_F_ITEM_FAILED: O item DLP do fechamento do bloco F não está verde\./);
});

test('m9d940 erro de leitura sai com exit 2', () => {
  // relatório DRY3 que não é JSON
  let amb = kit.ambiente();
  fs.writeFileSync(amb.cfg.dry3.arquivo, '{ isto não é json');
  let r = kit.fechar(amb, ['--itens', 'dry3']);
  assert.equal(r.status, 2, r.out);
  assert.match(r.stderr, /GOV_DOD_F_INVALID: Não foi possível verificar o fechamento do bloco F\./);
  assert.match(r.stdout, /^ERRO Migração v2 DRY3/m);
  // relatório JSON sem os seis critérios
  amb = kit.ambiente();
  kit.escrever(amb.cfg.dry3.arquivo, { conclusion: 'APROVADO' });
  assert.equal(kit.fechar(amb, ['--itens', 'dry3']).status, 2);
  // configuração ilegível
  amb = kit.ambiente();
  fs.writeFileSync(amb.cfgPath, 'não é json');
  r = kit.fechar(amb, ['--itens', 'dry3']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /GOV_DOD_F_INVALID/);
  // mapa dos testes do livro ilegível e opção inválida
  amb = kit.ambiente();
  fs.rmSync(path.join(amb.dir, 'mapa-livro.json'));
  assert.equal(kit.fechar(amb, ['--itens', 'adversarial']).status, 2);
  assert.equal(kit.fechar(kit.ambiente(), ['--itens', 'inexistente']).status, 2);
  // uma leitura quebrada vence a falha comum: nunca sai como "só reprovado"
  amb = kit.ambiente();
  fs.writeFileSync(amb.cfg.dry3.arquivo, 'x');
  kit.mapaDosNove(amb.dir, { sem: kit.NOMES_DO_LIVRO[0] });
  assert.equal(kit.fechar(amb, ['--itens', 'dry3,adversarial']).status, 2);
});

test('m9d940 o comando lê o relatório DRY3 do arquivo exportado e não do banco', () => {
  const origem = fs.readFileSync(path.join(kit.RAIZ, 'src/features/migration-v2/dryrun/dry.export.js'), 'utf8');
  assert.match(origem, /dry3-report\.json/, 'a exportação da M9-D908 grava o arquivo que o fechamento lê');
  const fonte = fs.readFileSync(path.join(kit.RAIZ, 'scripts/governance-ci/dodF/dry3.js'), 'utf8');
  assert.doesNotMatch(fonte, /sequelize|require\(['"]pg['"]\)|classificationDb|mig_dry_reports|DATABASE/i, 'o item DRY3 não abre banco');
  // sem nenhum banco acessível (URL que recusa conexão), o item lê o arquivo e aprova
  const semBanco = { DATABASE_URL: 'postgres://127.0.0.1:1/nunca', DATABASE_ADMIN_URL: 'postgres://127.0.0.1:1/nunca' };
  const amb = kit.ambiente();
  const ok = kit.fechar(amb, ['--itens', 'dry3'], semBanco);
  assert.equal(ok.status, 0, ok.out);
  assert.match(kit.linha(ok, 'DRY3'), /^OK Migração v2 DRY3: ensaio rel-m9d940 APROVADO/);
  // o arquivo manda: REPROVADO no arquivo reprova, mesmo que qualquer banco dissesse o contrário
  kit.escrever(amb.cfg.dry3.arquivo, kit.relatorioDry3({ conclusion: 'REPROVADO' }, { blockers_zero: { ok: false, count: 1 } }));
  assert.equal(kit.fechar(amb, ['--itens', 'dry3'], semBanco).status, 1);
  // arquivo ausente: o ensaio real não foi exportado, e o banco não é consultado como substituto
  fs.rmSync(amb.cfg.dry3.arquivo);
  const ausente = kit.fechar(amb, ['--itens', 'dry3'], semBanco);
  assert.equal(ausente.status, 1);
  assert.match(kit.linha(ausente, 'DRY3'), /não foi exportado/);
});
