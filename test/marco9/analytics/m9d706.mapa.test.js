'use strict';

// M9-D706 — o mapa sprint -> demandas (fonte única: a tabela 3.1 da própria demanda), a cobertura do bloco D, os 11 passos do Guia e a coerência
// das dependências com a ordem dos sprints.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregarDemandas } = require('../../../scripts/analytics/sprints/demandasMd');
const { lerMapa, PASSOS } = require('../../../scripts/analytics/sprints/mapa');
const { cobertura, dependenciasIncoerentes } = require('../../../scripts/analytics/sprints/avaliar');
const { montarFonte, SPRINTS_PADRAO } = require('../_helpers/sprintsFonte');

function mapaDe(fonte) {
  const demandas = carregarDemandas(fonte.dir);
  return { demandas, mapa: lerMapa(demandas.get('M9-D706').texto) };
}

test('m9d706 cada demanda do bloco D pertence a exatamente um sprint', () => {
  const fonte = montarFonte({ extras: ['M9-D650', 'M9-D660'] });
  try {
    const { demandas, mapa } = mapaDe(fonte);
    assert.equal(mapa.sprints.length, 9);
    const r = cobertura(mapa, demandas);
    assert.deepEqual(r.semSprint, ['M9-D650', 'M9-D660'], 'demanda do bloco sem sprint é achada');
  } finally { fonte.limpar(); }
  const dupla = montarFonte({ sprints: { ...SPRINTS_PADRAO, B3: ['M9-D616', 'M9-D615', 'M9-D999'] } });
  try {
    const { demandas, mapa } = mapaDe(dupla);
    const r = cobertura(mapa, demandas);
    assert.deepEqual(r.emVarios, [{ id: 'M9-D615', sprints: ['B2', 'B3'] }]);
    assert.deepEqual(r.inexistentes, [], 'D999 existe como arquivo (fixture) mas fora do bloco D6xx/D7xx não conta');
  } finally { dupla.limpar(); }
  const limpa = montarFonte();
  try {
    const { demandas, mapa } = mapaDe(limpa);
    assert.deepEqual(cobertura(mapa, demandas), { semSprint: [], emVarios: [], inexistentes: [] });
  } finally { limpa.limpar(); }
});

test('m9d706 sprint que aponta para demanda sem arquivo é reprovado', () => {
  const fonte = montarFonte();
  try {
    const demandas = carregarDemandas(fonte.dir);
    const mapa = lerMapa(demandas.get('M9-D706').texto);
    mapa.sprints[1].demandas.push('M9-D698');
    assert.deepEqual(cobertura(mapa, demandas).inexistentes, ['M9-D698']);
  } finally { fonte.limpar(); }
});

test('m9d706 os 11 passos do Guia mapeiam para sprints', () => {
  assert.equal(PASSOS.length, 11);
  assert.deepEqual(PASSOS.map((p) => p.n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const por = Object.fromEntries(PASSOS.map((p) => [p.n, p.sprints]));
  assert.deepEqual(por[1], ['B1']);
  assert.deepEqual(por[2], ['B1', 'B2', 'B3', 'B4', 'B5', 'B6']);
  assert.deepEqual(por[3], ['B1']);
  assert.deepEqual(por[4], ['B2']);
  assert.deepEqual(por[5], ['B3', 'B4']);
  assert.deepEqual([por[6], por[7], por[8]], [['B7'], ['B7'], ['B7']]);
  assert.deepEqual([por[9], por[10]], [['B8'], ['B8']]);
  assert.deepEqual(por[11], ['B9']);
  const fonte = montarFonte();
  try {
    const codigos = new Set(mapaDe(fonte).mapa.sprints.map((s) => s.codigo));
    for (const p of PASSOS) for (const s of p.sprints) assert.ok(codigos.has(s), `passo ${p.n} aponta para o sprint ${s}, que não está no mapa`);
    const cobertos = new Set(PASSOS.flatMap((p) => p.sprints));
    assert.deepEqual([...codigos].filter((c) => !cobertos.has(c)), [], 'todo sprint é coberto por algum passo');
  } finally { fonte.limpar(); }
});

test('m9d706 toda dependência aponta para sprint igual ou anterior', () => {
  const ok = montarFonte({ deps: { 'M9-D616': ['M9-D615'], 'M9-D615': ['M9-D600', 'M9-D615x'], 'M9-D706': ['M9-D693', 'M9-D706'] } });
  try {
    const { demandas, mapa } = mapaDe(ok);
    assert.deepEqual(dependenciasIncoerentes(mapa, demandas), [], 'mesmo sprint e sprint anterior passam');
  } finally { ok.limpar(); }
  const ruim = montarFonte({ deps: { 'M9-D615': ['M9-D616'], 'M9-D600': ['M9-D693', 'M9-D400'] } });
  try {
    const { demandas, mapa } = mapaDe(ruim);
    assert.deepEqual(dependenciasIncoerentes(mapa, demandas), [
      { id: 'M9-D600', sprint: 'B1', dependencia: 'M9-D693', sprintDaDependencia: 'B8' },
      { id: 'M9-D615', sprint: 'B2', dependencia: 'M9-D616', sprintDaDependencia: 'B3' },
    ], 'dependência de fora do bloco D (M9-D400) é ignorada; a que contraria a ordem é listada');
  } finally { ruim.limpar(); }
});
