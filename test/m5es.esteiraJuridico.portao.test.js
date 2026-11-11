'use strict';

/**
 * Guia do Marco 5, §17 (production_approval) e §22 ("Produção apenas depois de gates reais, falhas, restore e pentest"):
 * o portão de produção da esteira do jurídico (scripts/ci-juridico/gateProducao.js + gateRegras.js) BLOQUEIA a publicação
 * se faltar restore verde, pentest verde, se houver falha aberta (teste falho, pulado ou todo) ou se alguma etapa anterior
 * não estiver verde no mesmo commit; e libera só quando tudo isso vale, com a árvore limpa. Os casos rodam o portão de
 * verdade (processo filho, como a etapa 18 o chama) sobre pastas de evidência montadas aqui. Sem banco.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { avaliarPortao } = require('../scripts/ci-juridico/gateRegras');
const { etapasDeTeste } = require('../scripts/ci-juridico/gateProducao');
const { NOMES_DO_LIVRO } = require('../scripts/ci-juridico/etapas');

const ROOT = path.resolve(__dirname, '..');
const GATE = path.join(ROOT, 'scripts', 'ci-juridico', 'gateProducao.js');
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OUTRO = '05100be477a154ea39a26fcd558e1110d5378815';

function verde() {
  const etapas = NOMES_DO_LIVRO.slice(0, 17).map((nome, i) => ({ numero: i + 1, nome, status: 'VERDE', commit: SHA }));
  return {
    relatorio: { esteira: 'juridico (Guia M5 §17)', commit: SHA, dirty: false, etapas },
    restore: { commit: SHA, dirty: false, exitCode: 0, results: Array.from({ length: 141 }, (_, i) => ({ objectName: 'legal.contracts', label: `checagem ${i}`, ok: true })) },
    pentest: { meta: { commit: SHA, arquivosAlteradosNaoCommitados: 0, falhasFase: [], filtroDeRotas: null }, resumo: { rotas: 156, ataques: 1200, porGravidade: { critico: 0, alto: 0, medio: 0, baixo: 3 } }, ataques: [] },
    testes: Object.fromEntries(etapasDeTeste().map((e) => [e, [{ arquivo: 'test/x.test.js', nome: `teste da ${e}`, status: 'pass' }]])),
  };
}

function montar(c) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm5es-portao-'));
  const ev = path.join(dir, 'evidencias');
  fs.mkdirSync(path.join(ev, 'testes'), { recursive: true });
  if (c.relatorio) fs.writeFileSync(path.join(dir, 'esteira.json'), JSON.stringify(c.relatorio));
  if (c.restore) { fs.mkdirSync(path.join(ev, 'restore')); fs.writeFileSync(path.join(ev, 'restore', `drill-legal-restore-2026-11-11-${String(c.restore.commit).slice(0, 7)}.json`), JSON.stringify(c.restore)); }
  if (c.pentest) { fs.mkdirSync(path.join(ev, 'pentest')); fs.writeFileSync(path.join(ev, 'pentest', 'RELATORIO_PENTEST_M5.json'), JSON.stringify(c.pentest)); }
  for (const [etapa, linhas] of Object.entries(c.testes || {})) fs.writeFileSync(path.join(ev, 'testes', `${etapa}.jsonl`), linhas.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { dir, ev };
}

function rodarPortao(c) {
  const { dir, ev } = montar(c);
  const r = spawnSync(process.execPath, [GATE, '--relatorio', path.join(dir, 'esteira.json'), '--evidencias', ev, '--commit', SHA], { encoding: 'utf8' });
  const gravado = JSON.parse(fs.readFileSync(path.join(ev, 'portao-producao.json'), 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, saida: `${r.stdout}${r.stderr}`, codigos: gravado.bloqueios.map((b) => b.codigo), gravado };
}

test('portão: com etapas 1-17 verdes, restore e pentest verdes no mesmo commit e nenhuma falha aberta, LIBERA (exit 0)', () => {
  const r = rodarPortao(verde());
  assert.equal(r.status, 0, r.saida);
  assert.equal(r.gravado.liberado, true);
  assert.deepEqual(r.codigos, []);
  assert.match(r.saida, /LIBERADO/);
});

test('portão: sem relatório do drill de restore nesta execução, BLOQUEIA (GATE_RESTORE_AUSENTE)', () => {
  const c = verde(); delete c.restore;
  const r = rodarPortao(c);
  assert.equal(r.status, 1);
  assert.deepEqual(r.codigos, ['GATE_RESTORE_AUSENTE']);
  assert.match(r.saida, /LEGAL_PRODUCTION_GATE_BLOCKED/);
});

test('portão: restore vermelho (uma checagem reprovada ou exitCode 1) BLOQUEIA (GATE_RESTORE_VERMELHO)', () => {
  const c = verde(); c.restore.results[40].ok = false;
  assert.deepEqual(rodarPortao(c).codigos, ['GATE_RESTORE_VERMELHO']);
  const d = verde(); d.restore.exitCode = 1;
  assert.deepEqual(rodarPortao(d).codigos, ['GATE_RESTORE_VERMELHO']);
});

test('portão: restore com árvore suja ("dirty": true, como o drill de 05100be) ou de outro commit BLOQUEIA', () => {
  const c = verde(); c.restore.dirty = true;
  assert.deepEqual(rodarPortao(c).codigos, ['GATE_RESTORE_ARVORE_SUJA']);
  const d = verde(); d.restore.commit = OUTRO;
  assert.deepEqual(rodarPortao(d).codigos, ['GATE_RESTORE_OUTRO_COMMIT']);
});

test('portão: sem pentest, pentest incompleto ou com achado crítico/alto BLOQUEIA', () => {
  const a = verde(); delete a.pentest;
  assert.deepEqual(rodarPortao(a).codigos, ['GATE_PENTEST_AUSENTE']);
  const b = verde(); b.pentest.meta.falhasFase = ['preparo'];
  assert.deepEqual(rodarPortao(b).codigos, ['GATE_PENTEST_INCOMPLETO']);
  const c = verde(); c.pentest.ataques = [{ id: 'P1', veredito: 'achado', gravidade: 'alto', rota: 'POST /api/v1/legal/notices' }];
  assert.deepEqual(rodarPortao(c).codigos, ['GATE_PENTEST_ACHADO_GRAVE']);
  const d = verde(); d.pentest.resumo.porGravidade.critico = 1;
  assert.deepEqual(rodarPortao(d).codigos, ['GATE_PENTEST_ACHADO_GRAVE']);
  const e = verde(); e.pentest.meta.commit = OUTRO; e.pentest.meta.arquivosAlteradosNaoCommitados = 10;
  assert.deepEqual(rodarPortao(e).codigos, ['GATE_PENTEST_OUTRO_COMMIT', 'GATE_PENTEST_ARVORE_SUJA']);
});

test('portão: falha aberta — teste falho, pulado ou todo (defeito conhecido) em qualquer etapa — BLOQUEIA (GATE_FALHA_ABERTA)', () => {
  for (const status of ['fail', 'skip', 'todo']) {
    const c = verde();
    const etapa = etapasDeTeste()[3];
    c.testes[etapa].push({ arquivo: 'test/y.test.js', nome: `caso ${status}`, status, motivo: 'defeito aberto' });
    const r = rodarPortao(c);
    assert.equal(r.status, 1, status);
    assert.deepEqual(r.codigos, ['GATE_FALHA_ABERTA'], status);
    assert.match(r.gravado.bloqueios[0].detalhe, new RegExp(`${status} — test/y.test.js`));
  }
  const semResultado = verde(); delete semResultado.testes[etapasDeTeste()[0]];
  assert.deepEqual(rodarPortao(semResultado).codigos, ['GATE_TESTES_AUSENTES']);
});

test('portão: etapa anterior vermelha, execução parcial (só 16-17) ou árvore suja na esteira BLOQUEIA', () => {
  const a = verde(); a.relatorio.etapas[15].status = 'VERMELHO';
  assert.deepEqual(rodarPortao(a).codigos, ['GATE_ETAPA_NAO_VERDE']);
  const b = verde(); b.relatorio.etapas = b.relatorio.etapas.filter((e) => e.numero >= 16);
  const rb = rodarPortao(b);
  assert.equal(rb.codigos.length, 15);
  assert.ok(rb.codigos.every((x) => x === 'GATE_ETAPA_NAO_RODOU'));
  const c = verde(); c.relatorio.dirty = true;
  assert.deepEqual(rodarPortao(c).codigos, ['GATE_ARVORE_SUJA']);
  const d = verde(); d.relatorio.etapas[13].commit = OUTRO;
  assert.deepEqual(rodarPortao(d).codigos, ['GATE_ETAPA_OUTRO_COMMIT']);
});

test('portão: as etapas de teste exigidas são as que gravam resultado (3 a 12, failure_drills e pentest)', () => {
  assert.deepEqual(etapasDeTeste(), ['03-migrations', '04-contract_state_tests', '05-requirements_tests', '06-signature_adapter_contract_tests', '07-signature_webhook_idempotency_tests',
    '08-inspection_immutability_tests', '09-key_delivery_gate_tests', '10-deadline_tests', '11-evidence_integrity_tests', '12-multi_company_tests', '16-failure_drills', '17-pentest']);
  const r = avaliarPortao({ commit: SHA, ...verde(), restores: [], etapasDeTeste: etapasDeTeste() });
  assert.equal(r.liberado, false);
});

test('reporter da esteira: grava pass, fail, skip e todo com o status real (todo e skip não passam por verde)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm5es-reporter-'));
  const arq = path.join(dir, 'amostra.test.js');
  fs.writeFileSync(arq, [
    "const { test } = require('node:test');",
    "test('passa', () => {});",
    "test('falha', () => { throw new Error('quebrou'); });",
    "test('pulado', { skip: 'sem ambiente' }, () => {});",
    "test('aberto', { todo: 'defeito conhecido' }, () => { throw new Error('ainda falha'); });",
  ].join('\n'));
  const destino = path.join(dir, 'saida.jsonl');
  // Sem NODE_TEST_CONTEXT: dentro do node --test, o filho mandaria os eventos ao pai e ignoraria o reporter.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  spawnSync(process.execPath, ['--test', `--test-reporter=${path.join(ROOT, 'scripts', 'ci-juridico', 'reporterEsteira.js')}`, `--test-reporter-destination=${destino}`, arq], { cwd: dir, env, encoding: 'utf8' });
  const linhas = fs.readFileSync(destino, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(linhas.map((l) => [l.nome, l.status]), [['passa', 'pass'], ['falha', 'fail'], ['pulado', 'skip'], ['aberto', 'todo']]);
  assert.equal(linhas[3].motivo, 'defeito conhecido');
});
