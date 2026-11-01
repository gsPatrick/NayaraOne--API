'use strict';

// M9-D940 (reabertura R16, vem da M9-D908 R4-L4) — o item DRY3 do fechamento confere o vínculo do relatório: empresa, volume, idade, commit, árvore limpa e MIGRATION_DRY3_REPORT_PATH.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const kit = require('../_helpers/m9d940Fixtures');

const falhou = (r, motivo, rotulo) => {
  assert.equal(r.status, 1, `${rotulo}: ${r.out}`);
  assert.match(kit.linha(r, 'DRY3'), /^FALHA /, rotulo);
  assert.match(kit.linha(r, 'DRY3'), motivo, rotulo);
};
const rodar = (relatorio, { env = {}, cfg } = {}) => {
  const amb = kit.ambiente();
  if (cfg) { Object.assign(amb.cfg.dry3, cfg); amb.salvar(); }
  kit.escrever(amb.cfg.dry3.arquivo, relatorio);
  return kit.fechar(amb, ['--itens', 'dry3'], env);
};
const horas = (n) => new Date(Date.now() - n * 3600 * 1000).toISOString();

test('m9d940 relatório DRY3 íntegro e vinculado aprova', () => {
  const r = rodar(kit.relatorioDry3());
  assert.equal(r.status, 0, r.out);
});

test('m9d940 relatório DRY3 sem vínculo reprova o fechamento', () => {
  const casos = [
    ['sem empresa', kit.relatorioDry3({ company_id: null }), {}, /sem empresa/],
    ['outra empresa', kit.relatorioDry3(), { env: { MIGRATION_DRY3_COMPANY_ID: '99999999-2222-4333-8444-555555555555' } }, /outra empresa/],
    ['volume abaixo do mínimo padrão', kit.relatorioDry3({}, { counts_match: { ok: true, rows: 10 } }), {}, /volume do ensaio 10 abaixo do mínimo 1000/],
    ['volume abaixo do mínimo configurado', kit.relatorioDry3(), { cfg: { volume_minimo: 6000 } }, /abaixo do mínimo 6000/],
    ['relatório velho', kit.relatorioDry3({ generated_at: horas(200) }), {}, /mais de 168 h/],
    ['relatório velho pela validade configurada', kit.relatorioDry3({ generated_at: horas(3) }), { cfg: { validade_horas: 2 } }, /mais de 2 h/],
    ['data no futuro', kit.relatorioDry3({ generated_at: horas(-48) }), {}, /no futuro/],
    ['outro commit', kit.relatorioDry3({ commit: 'ffffffffffffffffffffffffffffffffffffffff' }), {}, /outro commit/],
    ['árvore alterada', kit.relatorioDry3({ dirty: true }), {}, /árvore alterada/],
  ];
  for (const [rotulo, relatorio, opcoes, motivo] of casos) falhou(rodar(relatorio, opcoes), motivo, rotulo);
});

test('m9d940 commit abreviado confere e exigir_commit_igual desligado aceita outro commit', () => {
  assert.equal(rodar(kit.relatorioDry3({ commit: kit.COMMIT_TESTE.slice(0, 8).toUpperCase() })).status, 0);
  const outro = kit.relatorioDry3({ commit: 'ffffffffffffffffffffffffffffffffffffffff', dirty: true });
  assert.equal(rodar(outro, { cfg: { exigir_commit_igual: false } }).status, 0);
});

test('m9d940 MIGRATION_DRY3_REPORT_PATH escolhe o arquivo do relatório', () => {
  const amb = kit.ambiente();
  const outro = path.join(amb.dir, 'outro-relatorio.json');
  kit.escrever(outro, kit.relatorioDry3({ dirty: true }));
  const r = kit.fechar(amb, ['--itens', 'dry3'], { MIGRATION_DRY3_REPORT_PATH: outro });
  falhou(r, /árvore alterada/, 'caminho do ambiente');
  kit.escrever(outro, kit.relatorioDry3());
  assert.equal(kit.fechar(amb, ['--itens', 'dry3'], { MIGRATION_DRY3_REPORT_PATH: outro }).status, 0);
});
