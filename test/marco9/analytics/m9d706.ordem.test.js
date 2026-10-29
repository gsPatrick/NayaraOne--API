'use strict';

// M9-D706 — estado de cada sprint, início fora de ordem e a saída do script (exit code e as linhas dos 9 sprints).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { carregarDemandas } = require('../../../scripts/analytics/sprints/demandasMd');
const { lerMapa } = require('../../../scripts/analytics/sprints/mapa');
const { estadoDosSprints, foraDeOrdem } = require('../../../scripts/analytics/sprints/avaliar');
const { montarFonte, SPRINTS_PADRAO } = require('../_helpers/sprintsFonte');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'analytics', 'checkSprintGates.js');
const carregar = (fonte) => { const d = carregarDemandas(fonte.dir); return { d, mapa: lerMapa(d.get('M9-D706').texto) }; };
const estados = (fonte, opcoes) => { const { d, mapa } = carregar(fonte); return Object.fromEntries(estadoDosSprints(mapa, d, opcoes).map((s) => [s.codigo, s.estado])); };
const roda = (fonte, ...args) => spawnSync(process.execPath, [SCRIPT, '--demandas', fonte.dir, ...args], { encoding: 'utf8' });

test('m9d706 o script calcula aberto, em andamento e fechado a partir dos arquivos de demanda', () => {
  const fonte = montarFonte({ sprints: { ...SPRINTS_PADRAO, B2: ['M9-D615', 'M9-D620'] },
    status: { 'M9-D600': 'verificada', 'M9-D601': 'verificada', 'M9-D615': 'verificada', 'M9-D620': 'corrigida', 'M9-D616': 'em_execucao' } });
  try {
    const e = estados(fonte);
    assert.equal(e.B1, 'fechado');
    assert.equal(e.B2, 'em andamento', 'uma verificada e uma corrigida');
    assert.equal(e.B3, 'em andamento');
    assert.equal(e.B4, 'aberto');
    const b2 = estadoDosSprints(carregar(fonte).mapa, carregar(fonte).d)[1];
    assert.deepEqual([b2.total, b2.verificadas], [2, 1]);
  } finally { fonte.limpar(); }
});

test('m9d706 o script detecta sprint iniciado fora de ordem', () => {
  const fonte = montarFonte({ status: { 'M9-D693': 'em_execucao', 'M9-D600': 'verificada', 'M9-D601': 'corrigida' } });
  try {
    const { d, mapa } = carregar(fonte);
    const v = foraDeOrdem(mapa, d);
    assert.deepEqual(v.map((x) => [x.id, x.sprint]), [['M9-D693', 'B8']]);
    assert.deepEqual(v[0].bloqueadoPor, ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7'], 'B1 não está fechado (D601 só corrigida) e B2 a B7 estão abertos');
    const r = roda(fonte);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /fora de ordem/i);
    assert.match(r.stderr, /M9-D693/);
  } finally { fonte.limpar(); }
});

test('m9d706 iniciar o sprint seguinte com o anterior fechado é permitido e o status que conta como iniciado é parâmetro', () => {
  const fonte = montarFonte({ status: { 'M9-D600': 'verificada', 'M9-D601': 'verificada', 'M9-D615': 'em_execucao', 'M9-D616': 'corrigida' } });
  try {
    const { d, mapa } = carregar(fonte);
    assert.deepEqual(foraDeOrdem(mapa, d).map((x) => x.id), [], 'B2 em execução com B1 fechado: ordem respeitada');
    const estrito = foraDeOrdem(mapa, d, { iniciados: ['em_execucao', 'corrigida'] });
    assert.deepEqual(estrito.map((x) => x.id), ['M9-D616'], 'corrigida em B3 com B2 aberto reprova quando o administrador a conta como iniciada');
    const ok = roda(fonte);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const ruim = roda(fonte, '--iniciado', 'em_execucao,corrigida');
    assert.equal(ruim.status, 1);
  } finally { fonte.limpar(); }
});

test('m9d706 a saída do script mostra o estado dos 9 sprints e os 11 passos', () => {
  const fonte = montarFonte({ status: { 'M9-D600': 'verificada', 'M9-D601': 'verificada' } });
  try {
    const r = roda(fonte);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (let n = 1; n <= 9; n += 1) assert.match(r.stdout, new RegExp(`^B${n} .*(aberto|em andamento|fechado)`, 'm'));
    assert.match(r.stdout, /^B1 .*fechado/m);
    assert.match(r.stdout, /^B2 .*aberto/m);
    assert.match(r.stdout, /passo 11/i);
    const j = JSON.parse(roda(fonte, '--json').stdout);
    assert.equal(j.sprints.length, 9);
    assert.equal(j.ok, true);
  } finally { fonte.limpar(); }
});

test('m9d706 sem a pasta de demandas o script reprova com mensagem clara', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--demandas', path.join(__dirname, 'nao-existe-m9d706')], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pasta de demandas/i);
});
