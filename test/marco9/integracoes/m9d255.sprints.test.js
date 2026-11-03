'use strict';

// Marco 9, M9-D255 — ordem de implementação e sprints I1 a I9: cobertura do bloco, coerência com as dependências, portão por sprint e documento gerado.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { carregarDemandas, pastaPadrao } = require('../../../scripts/analytics/sprints/demandasMd');
const { lerMapa } = require('../../../scripts/int-sprint/lib/mapa');
const A = require('../../../scripts/int-sprint/lib/avaliar');
const { avaliarSprint } = require('../../../scripts/int-sprint/lib/portao');
const { gerarDocumento } = require('../../../scripts/int-sprint/lib/documento');
const { montarFonte } = require('../_helpers/intSprintFonte');
const { motivoNaoAplicavel } = require('../../helpers/repoIrmao');

// As três provas abaixo leem as demandas reais de Maturacao/ (só existe ao lado da API na máquina de quem desenvolve): ausente, falham; no CI com CI_SEM_REPOS_IRMAOS=1 viram NAO_APLICAVEL_NO_CI.
const DEMANDAS_REAIS = { skip: motivoNaoAplicavel(['Maturacao/demandas/marco-9']) };

const raiz = path.join(__dirname, '..', '..', '..');
const fontes = [];
const fonte = (opcoes) => { const f = montarFonte(opcoes); fontes.push(f); return f; };
after(() => fontes.forEach((f) => f.limpar()));

const real = () => { const demandas = carregarDemandas(pastaPadrao()); return { demandas, mapa: lerMapa(demandas.get('M9-D255').texto) }; };
const semExigencia = { testes: [], comandos: [], semTeste: [] };

test('sprints_cobrem_todas_as_demandas_do_bloco', DEMANDAS_REAIS, () => {
  const { demandas, mapa } = real();
  assert.deepEqual(mapa.sprints.map((s) => s.codigo), ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9']);
  assert.equal(mapa.passos.length, 11, 'os 11 passos do livro');
  const cob = A.cobertura(mapa, demandas);
  assert.deepEqual(cob, { semSprint: [], emVarios: [], inexistentes: [] }, 'nenhuma demanda órfã, repetida ou inexistente');
  assert.deepEqual(A.passosSemDestino(mapa, demandas), [], 'cada passo do livro tem demandas, todas dentro de um sprint');
  // O que o livro põe em cada sprint (Guia §12) está nas demandas certas.
  const por = A.sprintsPorDemanda(mapa);
  assert.deepEqual([por.get('M9-D229'), por.get('M9-D222'), por.get('M9-D236'), por.get('M9-D240'), por.get('M9-D256')], [['I3'], ['I3'], ['I5'], ['I7'], ['I9']]);
  // Cobertura quebrada é vista: uma demanda do bloco fora da tabela e uma citada sem arquivo.
  const f = fonte({ extras: ['D230'] });
  const falsa = carregarDemandas(f.dir);
  const m = lerMapa(falsa.get('M9-D255').texto);
  assert.deepEqual(A.cobertura(m, falsa).semSprint, ['M9-D230']);
  falsa.delete('M9-D200');
  assert.deepEqual(A.cobertura(m, falsa).inexistentes, ['M9-D200']);
});

test('sprints_ordem_respeita_dependencias', DEMANDAS_REAIS, () => {
  const { demandas, mapa } = real();
  assert.deepEqual(A.dependenciasIncoerentes(mapa, demandas), [], 'nenhuma demanda depende de sprint posterior');
  for (const s of mapa.sprints) {
    const { ordem, ciclo } = A.ordemDeExecucao(mapa, demandas, s.codigo);
    assert.deepEqual(ciclo, [], `${s.codigo} sem dependência circular`);
    assert.deepEqual([...ordem].sort(), [...s.demandas].sort(), `${s.codigo}: a ordem de execução tem as mesmas demandas`);
    ordem.forEach((id, i) => demandas.get(id).dependencias.filter((dep) => s.demandas.includes(dep)).forEach((dep) => assert.ok(ordem.indexOf(dep) < i, `${id} vem depois de ${dep}`)));
  }
  // O livro adianta D229 e D226: a suíte de contrato roda no adapter que já existe e a quarentena (D247) vem depois do storage (D242).
  const i3 = A.ordemDeExecucao(mapa, demandas, 'I3').ordem;
  assert.ok(i3.indexOf('M9-D229') < i3.indexOf('M9-D222') && i3.indexOf('M9-D242') < i3.indexOf('M9-D247') && i3.indexOf('M9-D226') < i3.indexOf('M9-D242'));
  // Contradição é vista: dependência de sprint posterior e dependência circular.
  const f = fonte({ deps: { D200: ['D211'] } });
  const falsa = carregarDemandas(f.dir);
  assert.deepEqual(A.dependenciasIncoerentes(lerMapa(falsa.get('M9-D255').texto), falsa), [{ id: 'M9-D200', sprint: 'I1', dependencia: 'M9-D211', sprintDaDependencia: 'I3' }]);
  const g = fonte({ deps: { D200: ['D201'], D201: ['D200'] } });
  const circular = carregarDemandas(g.dir);
  assert.deepEqual(A.ordemDeExecucao(lerMapa(circular.get('M9-D255').texto), circular, 'I1').ciclo, ['M9-D200', 'M9-D201']);
});

test('portao_de_sprint_exige_demandas_verificadas', () => {
  const aberto = carregarDemandas(fonte({ status: { D200: 'verificada', D201: 'corrigida' } }).dir);
  const mapa = lerMapa(aberto.get('M9-D255').texto);
  const r = avaliarSprint(mapa, aberto, 'I1', { exigencias: semExigencia });
  assert.equal(r.ok, false);
  assert.deepEqual([r.code, r.message], ['INTEGRATION_SPRINT_GATE_FAILED', 'Há demandas do sprint ainda não verificadas.']);
  assert.deepEqual(r.demandas, { total: 2, verificadas: 1, naoVerificadas: [{ id: 'M9-D201', status: 'corrigida' }] });
  assert.match(r.motivos.join('\n'), /M9-D201 está corrigida/);
  const fechado = carregarDemandas(fonte({ status: { D200: 'verificada', D201: 'verificada' } }).dir);
  const ok = avaliarSprint(lerMapa(fechado.get('M9-D255').texto), fechado, 'I1', { exigencias: semExigencia });
  assert.deepEqual([ok.ok, ok.code, ok.motivos], [true, null, []]);
  // Teste do portão ausente ou não executado também reprova: o sprint não fecha só por status.
  const semTeste = avaliarSprint(lerMapa(fechado.get('M9-D255').texto), fechado, 'I1', { exigencias: { testes: [{ arquivos: ['test/nao-existe.test.js'] }], comandos: [], semTeste: ['M9-D201'] }, raiz });
  assert.equal(semTeste.ok, false);
  assert.match(semTeste.motivos.join('\n'), /M9-D201 não tem teste nomeado[\s\S]*teste do portão ausente/);
  // Início fora de ordem: demanda do I2 em execução com o I1 aberto.
  const fora = carregarDemandas(fonte({ status: { D200: 'verificada', D201: 'corrigida', D206: 'em_execucao' } }).dir);
  assert.match(avaliarSprint(lerMapa(fora.get('M9-D255').texto), fora, 'I2', { exigencias: semExigencia }).motivos.join('\n'), /M9-D206 em_execucao com o sprint I1 ainda não fechado/);
  assert.throws(() => avaliarSprint(mapa, aberto, 'I10', { exigencias: semExigencia }), /sprint desconhecido/);
});

test('portao_de_sprint_script_sai_com_1_e_codigo', () => {
  const f = fonte({ status: { D200: 'verificada', D201: 'corrigida' } });
  const r = spawnSync(process.execPath, ['scripts/integrationSprintGate.js', '--sprint', 'I1', '--demandas', f.dir], { cwd: raiz, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /INTEGRATION_SPRINT_GATE_FAILED: Há demandas do sprint ainda não verificadas\./);
  assert.match(r.stdout, /I1 tema I1: PORTAO REPROVADO/);
  const painel = spawnSync(process.execPath, ['scripts/integrationSprintGate.js', '--demandas', f.dir], { cwd: raiz, encoding: 'utf8' });
  assert.equal(painel.status, 0, painel.stderr);
  assert.match(painel.stdout, /I1 tema I1: em andamento \(1\/2 verificadas\)/);
});

test('sprints_documento_atualizado', DEMANDAS_REAIS, () => {
  const { demandas, mapa } = real();
  const arquivo = fs.readFileSync(path.join(raiz, 'docs', 'integrations', 'SPRINTS.md'), 'utf8');
  assert.equal(arquivo, gerarDocumento(mapa, demandas), 'docs/integrations/SPRINTS.md é o gerado da tabela da M9-D255 (rode --gerar-doc)');
  assert.match(arquivo, /\| I9 \|/);
});
