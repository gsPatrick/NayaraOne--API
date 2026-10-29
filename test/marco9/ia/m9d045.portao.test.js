'use strict';

// M9-D045 — o portão de saída de cada sprint: demanda não verificada, testes do tema do livro (AI4, AI6, AI7) e o AI2 sem proposals.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregarDemandas } = require('../../../scripts/analytics/sprints/demandasMd');
const { lerMapa } = require('../../../scripts/ai-sprint/lib/mapa');
const { avaliarSprint } = require('../../../scripts/ai-sprint/lib/portao');
const { exigenciasDoSprint } = require('../../../scripts/ai-sprint/lib/exigencias');
const { verificarPiloto } = require('../../../scripts/ai-sprint/lib/piloto');
const { montarFonte, montarTestes } = require('../_helpers/iaSprintFonte');

const VAZIO = { testes: [], comandos: [], verificacoes: [] };
const TEMA = {
  AI4: ['m9d025_resposta_factual_exige_fonte_e_snapshot', 'm9d025_divergencia_listada_com_versoes', 'm9d026_numero_sem_origem_rejeitado', 'adv_fonte_revogada_nao_usada_como_vigente'],
  AI6: ['m9d019_aprovador_distinto', 'm9d019_snapshot_mudou_409_e_vira_stale', 'm9d019_execucao_idempotente_duas_conexoes'],
  AI7: ['m9d012_decisao_deterministica', 'm9d013_fallback_seguro', 'm9d014_alerta_50_75_90_100_uma_vez_cada', 'm9d015_cache_nao_guarda_confidential_nem_restricted'],
};

function mapaDe(fonte) {
  const demandas = carregarDemandas(fonte.dir);
  return { demandas, mapa: lerMapa(demandas.get('M9-D045').texto) };
}

test('m9d045_portao_de_sprint_recusa_demanda_nao_verificada', () => {
  const aberto = montarFonte({ status: { D006: 'verificada', D020: 'corrigida' } });
  try {
    const { demandas, mapa } = mapaDe(aberto);
    const r = avaliarSprint(mapa, demandas, 'AI2', { exigencias: VAZIO });
    assert.equal(r.ok, false);
    assert.deepEqual(r.demandas.naoVerificadas, [{ id: 'M9-D020', status: 'corrigida' }]);
    assert.match(r.motivos[0], /M9-D020 está corrigida/);
  } finally { aberto.limpar(); }
  const fechado = montarFonte({ status: { D006: 'verificada', D020: 'verificada' } });
  try {
    const { demandas, mapa } = mapaDe(fechado);
    assert.equal(avaliarSprint(mapa, demandas, 'AI2', { exigencias: VAZIO }).ok, true);
    assert.throws(() => avaliarSprint(mapa, demandas, 'AI99'), /sprint desconhecido/);
  } finally { fechado.limpar(); }
});

test('m9d045_portao_tematico_reexecuta_testes_do_tema_do_livro', () => {
  for (const [sprint, nomes] of Object.entries(TEMA)) {
    const nomesExigidos = exigenciasDoSprint(sprint).testes.filter((t) => t.nome).map((t) => t.nome);
    for (const n of nomes) assert.ok(nomesExigidos.includes(n), `${sprint} exige ${n}`);
  }
  const fonte = montarFonte({ status: { D024: 'verificada' } });
  const completa = montarTestes(TEMA.AI4);
  const faltando = montarTestes(TEMA.AI4.slice(1));
  try {
    const { demandas, mapa } = mapaDe(fonte);
    const ex = { testes: TEMA.AI4.map((nome) => ({ nome })), comandos: [], verificacoes: [] };
    const presentes = avaliarSprint(mapa, demandas, 'AI4', { exigencias: ex, raiz: completa.raiz });
    assert.deepEqual(presentes.testes.map((t) => t.estado), ['nao_executado', 'nao_executado', 'nao_executado', 'nao_executado'], 'presente sem execução não fecha');
    assert.equal(presentes.ok, false);
    const ausente = avaliarSprint(mapa, demandas, 'AI4', { exigencias: ex, raiz: faltando.raiz });
    assert.equal(ausente.ok, false);
    assert.match(ausente.motivos.join('\n'), /teste do portão ausente: m9d025_resposta_factual_exige_fonte_e_snapshot/);
  } finally { fonte.limpar(); completa.limpar(); faltando.limpar(); }
});

test('m9d045_portao_tematico_reexecuta_testes_do_tema_do_livro vermelho reprova e verde aprova', () => {
  const fonte = montarFonte({ status: { D024: 'verificada' } });
  const testes = montarTestes(['m9d025_a', 'm9d025_b']);
  const tap = (ok) => ({ status: 0, stdout: `${ok.map((n, i) => `ok ${i + 1} - ${n}`).join('\n')}\n${ok.length < 2 ? 'not ok 3 - m9d025_b\n' : ''}`, stderr: '' });
  try {
    const { demandas, mapa } = mapaDe(fonte);
    const ex = { testes: [{ nome: 'm9d025_a' }, { nome: 'm9d025_b' }], comandos: [], verificacoes: [] };
    const vermelho = avaliarSprint(mapa, demandas, 'AI4', { exigencias: ex, raiz: testes.raiz, executar: true, spawn: () => tap(['m9d025_a']) });
    assert.deepEqual(vermelho.testes.map((t) => t.estado), ['verde', 'vermelho']);
    assert.equal(vermelho.ok, false);
    const verde = avaliarSprint(mapa, demandas, 'AI4', { exigencias: ex, raiz: testes.raiz, executar: true, spawn: () => tap(['m9d025_a', 'm9d025_b']) });
    assert.equal(verde.ok, true);
    const pulado = avaliarSprint(mapa, demandas, 'AI4', { exigencias: ex, raiz: testes.raiz, executar: true, spawn: () => ({ status: 0, stdout: 'ok 1 - m9d025_a\nok 2 - m9d025_b # SKIP sem banco\n', stderr: '' }) });
    assert.deepEqual(pulado.testes.map((t) => t.estado), ['verde', 'vermelho'], 'teste pulado não vale como verde');
  } finally { fonte.limpar(); testes.limpar(); }
});

test('m9d045_ai2_nao_libera_proposals_antes_do_ai6', () => {
  assert.deepEqual(exigenciasDoSprint('AI2').verificacoes, ['piloto']);
  assert.deepEqual(exigenciasDoSprint('AI6').verificacoes, [], 'a liberação de proposals é do AI6');
  const real = verificarPiloto();
  assert.equal(real.ok, true, real.motivos.join('; '));
  assert.ok(real.tools.length > 0);
  const defs = [{ name: 'crm.getOpportunity', category: 'READ' }, { name: 'crm.createFollowUpTask', category: 'WRITE' }];
  const comEscrita = verificarPiloto({ politica: { TOOLS: [{ toolName: 'crm.getOpportunity' }, { toolName: 'crm.createFollowUpTask', requiresHumanApproval: true }] }, definicoes: defs, padroes: { k: false }, chave: 'k' });
  assert.equal(comEscrita.ok, false);
  assert.match(comEscrita.motivos.join('\n'), /tool de escrita crm\.createFollowUpTask/);
  const ligado = verificarPiloto({ politica: { TOOLS: [{ toolName: 'crm.getOpportunity' }] }, definicoes: defs, padroes: { k: true }, chave: 'k' });
  assert.equal(ligado.ok, false);
  assert.match(ligado.motivos.join('\n'), /não está Desligado/);
  const fonte = montarFonte({ status: { D006: 'verificada', D020: 'verificada' } });
  try {
    const { demandas, mapa } = mapaDe(fonte);
    const r = avaliarSprint(mapa, demandas, 'AI2', { exigencias: { testes: [], comandos: [], verificacoes: ['piloto'] } });
    assert.equal(r.ok, true);
    assert.equal(r.verificacoes[0].ok, true);
  } finally { fonte.limpar(); }
});

test('m9d045_portao_de_sprint_recusa_demanda_nao_verificada pela linha de comando', () => {
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const fonte = montarFonte({ status: { D006: 'verificada', D020: 'em_execucao' } });
  try {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', '..', 'scripts', 'ai-sprint-gate.js'), '--sprint', 'AI2', '--demandas', fonte.dir], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /AI2 tools\/read-only|AI2 tema AI2/);
    assert.match(r.stdout, /M9-D020: em_execucao/);
    const painel = spawnSync(process.execPath, [path.join(__dirname, '..', '..', '..', 'scripts', 'ai-sprint-gate.js'), '--demandas', fonte.dir], { encoding: 'utf8' });
    assert.match(painel.stdout, /AI1 tema AI1: aberto/);
  } finally { fonte.limpar(); }
});
