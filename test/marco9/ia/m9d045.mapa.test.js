'use strict';

// M9-D045 — o mapa da ordem exata e dos 10 sprints (fonte única: a tabela da própria demanda), cobertura e dependências na ordem.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { carregarDemandas } = require('../../../scripts/analytics/sprints/demandasMd');
const { lerMapa, idsDe } = require('../../../scripts/ai-sprint/lib/mapa');
const A = require('../../../scripts/ai-sprint/lib/avaliar');
const { montarFonte, SPRINTS } = require('../_helpers/iaSprintFonte');

function carregar(fonte) {
  const demandas = carregarDemandas(fonte.dir);
  return { demandas, mapa: lerMapa(demandas.get('M9-D045').texto) };
}

test('m9d045_toda_demanda_do_bloco_em_um_sprint', () => {
  const fonte = montarFonte({ extras: ['D030', 'D031'] });
  try {
    const { demandas, mapa } = carregar(fonte);
    assert.equal(mapa.sprints.length, 4);
    assert.deepEqual(A.cobertura(mapa, demandas).semSprint, ['M9-D030', 'M9-D031'], 'demanda do bloco A fora da tabela é achada');
    assert.equal(A.cobertura(mapa, demandas).semSprint.includes('M9-D045'), false, 'a M9-D045 é o portão: não precisa de sprint');
  } finally { fonte.limpar(); }
  const dupla = montarFonte({ sprints: { ...SPRINTS, AI3: ['D022', 'D023', 'D010'] } });
  try {
    const { demandas, mapa } = carregar(dupla);
    assert.deepEqual(A.cobertura(mapa, demandas).emVarios, [{ id: 'M9-D010', sprints: ['AI1', 'AI3'] }]);
  } finally { dupla.limpar(); }
  const limpa = montarFonte();
  try {
    const { demandas, mapa } = carregar(limpa);
    assert.deepEqual(A.cobertura(mapa, demandas), { semSprint: [], emVarios: [], inexistentes: [] });
    assert.deepEqual(A.passosSemDestino(mapa, demandas), []);
    assert.deepEqual(mapa.passos.map((p) => p.demandas), [['M9-D010'], ['M9-D001'], ['M9-D006', 'M9-D020'], ['M9-D022', 'M9-D023', 'M9-D024']], 'intervalo "D022 a D024" expande');
    mapa.sprints[1].demandas.push('M9-D038');
    assert.deepEqual(A.cobertura(mapa, demandas).inexistentes, ['M9-D038'], 'o mapa cita demanda sem arquivo');
  } finally { limpa.limpar(); }
});

test('m9d045_toda_demanda_do_bloco_em_um_sprint passo sem demanda é achado', () => {
  const fonte = montarFonte({ passos: [{ n: 1, nome: 'x', ids: 'D010' }, { n: 2, nome: 'y', ids: 'D010' }] });
  try {
    const { demandas, mapa } = carregar(fonte);
    mapa.passos.push({ n: 3, nome: 'sem nada', demandas: [] });
    assert.deepEqual(A.passosSemDestino(mapa, demandas), [3]);
  } finally { fonte.limpar(); }
  assert.deepEqual(idsDe('D034 (com D020)'), ['M9-D034', 'M9-D020']);
});

test('m9d045_dependencias_respeitadas_na_ordem', () => {
  const ok = montarFonte({ deps: { D020: ['D006', 'D010'], D024: ['D022'] } });
  try {
    const { demandas, mapa } = carregar(ok);
    assert.deepEqual(A.dependenciasIncoerentes(mapa, demandas), []);
  } finally { ok.limpar(); }
  const ruim = montarFonte({ deps: { D010: ['D024'], D006: ['D022'] } });
  try {
    const { demandas, mapa } = carregar(ruim);
    assert.deepEqual(A.dependenciasIncoerentes(mapa, demandas), [
      { id: 'M9-D006', sprint: 'AI2', dependencia: 'M9-D022', sprintDaDependencia: 'AI3' },
      { id: 'M9-D010', sprint: 'AI1', dependencia: 'M9-D024', sprintDaDependencia: 'AI4' },
    ]);
  } finally { ruim.limpar(); }
});

test('m9d045_dependencias_respeitadas_na_ordem início fora de ordem é achado', () => {
  const fonte = montarFonte({ status: { D001: 'verificada', D010: 'corrigida', D006: 'em_execucao' } });
  try {
    const { demandas, mapa } = carregar(fonte);
    assert.deepEqual(A.foraDeOrdem(mapa, demandas), [{ id: 'M9-D006', sprint: 'AI2', status: 'em_execucao', bloqueadoPor: ['AI1'] }]);
    assert.deepEqual(A.foraDeOrdem(mapa, demandas, { iniciadas: ['corrigida'] }).map((v) => v.id), [], 'a corrigida do próprio AI1 não é fora de ordem');
  } finally { fonte.limpar(); }
});
