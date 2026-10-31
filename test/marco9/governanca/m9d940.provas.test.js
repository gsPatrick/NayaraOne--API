'use strict';

// M9-D940 — cada prova do DoD do bloco F reprova sozinha o fechamento (DRY3, lineage, manifest e os nove testes do livro).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const kit = require('../_helpers/m9d940Fixtures');

const itens = (chaves) => ['--itens', chaves];
const falhou = (r, nome) => { assert.equal(r.status, 1, r.out); assert.match(kit.linha(r, nome), /^FALHA /, r.out); assert.match(r.stderr, /GOV_DOD_F_ITEM_FAILED/); };

test('m9d940 DRY3 não aprovado reprova o fechamento', () => {
  const casos = [
    ['blocker aberto', kit.relatorioDry3({ conclusion: 'REPROVADO' }, { blockers_zero: { ok: false, count: 1, codes: ['GOV_MIG_X'] } }), /conclusão REPROVADO.*blockers_zero/],
    ['critério vermelho com conclusão APROVADO', kit.relatorioDry3({}, { rollback_simulated: { ok: false } }), /rollback_simulated/],
    ['lote não verificado (99%)', kit.relatorioDry3({}, { batches_verified: { ok: true, total: 100, verified: 99, pct: 99 } }), /lotes VERIFIED 99\/100/],
    ['sem lote nenhum', kit.relatorioDry3({}, { batches_verified: { ok: true, total: 0, verified: 0, pct: 0 } }), /lotes VERIFIED 0\/0/],
    ['commit desconhecido', kit.relatorioDry3({ commit: 'unknown' }), /commit do ensaio desconhecido/],
    ['data inválida', kit.relatorioDry3({ generated_at: 'ontem' }), /data de geração/],
  ];
  for (const [rotulo, relatorio, motivo] of casos) {
    const amb = kit.ambiente();
    kit.escrever(amb.cfg.dry3.arquivo, relatorio);
    const r = kit.fechar(amb, itens('dry3'));
    falhou(r, 'DRY3');
    assert.match(kit.linha(r, 'DRY3'), motivo, rotulo);
  }
});

test('m9d940 KPI ou campo de migração sem lineage reprova o fechamento', () => {
  const real = kit.RAIZ;
  const mapa = JSON.parse(fs.readFileSync(path.join(real, 'docs/governance/migration-field-map.json'), 'utf8'));
  // campo crítico novo no mapa da migração sem caminho no registro
  let amb = kit.ambiente();
  const mapaTmp = path.join(amb.dir, 'mapa.json');
  kit.escrever(mapaTmp, [...mapa, { entity: 'PERSON', sourceSystem: 'LEGADO_ERP', sourceField: 'clientes.qa_m9d940_mae', domainField: 'people.persons.qa_m9d940_mae', critical: true }]);
  amb.cfg.lineage.mapa = mapaTmp;
  amb.salvar();
  let r = kit.fechar(amb, itens('lineage'));
  falhou(r, 'lineage crítico');
  assert.match(kit.linha(r, 'lineage crítico'), /GOV_LINEAGE/);
  // registro sem a área MIGRATION (campos da migração fora do lineage)
  amb = kit.ambiente();
  const registro = JSON.parse(fs.readFileSync(path.join(real, 'docs/governance/lineage-registry.json'), 'utf8'));
  const semMigracao = path.join(amb.dir, 'registro.json');
  kit.escrever(semMigracao, { ...registro, nodes: registro.nodes.filter((n) => n.area !== 'MIGRATION'), edges: registro.edges.filter((e) => !String(e.from.code).includes('LEGADO')) });
  amb.cfg.lineage.registro = semMigracao;
  amb.salvar();
  r = kit.fechar(amb, itens('lineage'));
  falhou(r, 'lineage crítico');
  // registro ilegível não é "ok": exit 2
  amb = kit.ambiente();
  amb.cfg.lineage.registro = path.join(amb.dir, 'nao-existe.json');
  amb.salvar();
  assert.equal(kit.fechar(amb, itens('lineage')).status, 2);
  // o real passa
  amb = kit.ambiente();
  const ok = kit.fechar(amb, itens('lineage'));
  assert.equal(ok.status, 0, ok.out);
  assert.match(kit.linha(ok, 'lineage'), /cobertura crítica 54\/54.*área MIGRATION/);
});

test('m9d940 manifest com byte alterado reprova o fechamento', () => {
  const amb = kit.ambiente();
  assert.equal(kit.fechar(amb, itens('manifest')).status, 0);
  fs.appendFileSync(path.join(amb.dir, 'DOC_2.txt'), 'x');
  const r = kit.fechar(amb, itens('manifest'));
  falhou(r, 'manifest documental');
  assert.match(kit.linha(r, 'manifest documental'), /GOV_MANIFEST_HASH_MISMATCH/);
  // manifest ausente
  fs.rmSync(path.join(amb.dir, 'saida', 'manifest.json'));
  const ausente = kit.fechar(amb, itens('manifest'));
  falhou(ausente, 'manifest documental');
  assert.match(kit.linha(ausente, 'manifest documental'), /GOV_MANIFEST_FILE_MISSING/);
});

test('m9d940 teste do livro do bloco F ausente ou ignorado reprova o fechamento', () => {
  const amb = kit.ambiente();
  const ok = kit.fechar(amb, itens('adversarial'));
  assert.equal(ok.status, 0, ok.out);
  assert.match(kit.linha(ok, 'testes do livro'), /9 de 9 testes nomeados presentes e ativos/);
  for (const nome of kit.NOMES_DO_LIVRO) {
    kit.mapaDosNove(amb.dir, { sem: nome });
    const ausente = kit.fechar(amb, itens('adversarial'));
    falhou(ausente, 'testes do livro');
    assert.match(kit.linha(ausente, 'testes do livro'), new RegExp(`GOV_ADVERSARIAL_MISSING ${nome.slice(0, 12)}.*ausente`), nome);
  }
  kit.mapaDosNove(amb.dir, { comoSkip: kit.NOMES_DO_LIVRO[4] });
  const ignorado = kit.fechar(amb, itens('adversarial'));
  falhou(ignorado, 'testes do livro');
  assert.match(kit.linha(ignorado, 'testes do livro'), /legal hold sempre prevalece.*skip ou todo/);
  // o mapa real do repositório tem os nove nomes do livro
  const real = JSON.parse(fs.readFileSync(path.join(kit.RAIZ, 'docs/governance/dod-bloco-f-adversarial.json'), 'utf8'));
  assert.deepEqual(real.itens.flatMap((i) => i.testes), kit.NOMES_DO_LIVRO);
  assert.equal(real.itens_do_livro, 9);
});
