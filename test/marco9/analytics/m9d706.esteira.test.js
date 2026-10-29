'use strict';

// M9-D706 (critério transferido da M9-D705) — o sprint B9 só fecha com a esteira do BI: 11 etapas APROVADAS, etapa 11 com os dois testes de
// carga verdes no log e a evidência recente.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { avaliarEsteira } = require('../../../scripts/analytics/sprints/esteira');
const { carregarDemandas } = require('../../../scripts/analytics/sprints/demandasMd');
const { lerMapa } = require('../../../scripts/analytics/sprints/mapa');
const { estadoDosSprints } = require('../../../scripts/analytics/sprints/avaliar');
const { montarFonte, SPRINTS_PADRAO } = require('../_helpers/sprintsFonte');
const { montarEsteira, CARGA } = require('../_helpers/esteiraFonte');

const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'analytics', 'checkSprintGates.js');
const tudoVerificada = Object.fromEntries(Object.values(SPRINTS_PADRAO).flat().map((id) => [id, 'verificada']));

test('m9d706 esteira com as 11 etapas aprovadas e os dois testes de carga verdes libera o B9', () => {
  const e = montarEsteira();
  try { assert.deepEqual(avaliarEsteira({ dir: e.dir }), { ok: true, motivos: [] }); } finally { e.limpar(); }
});

test('m9d706 esteira reprovada, etapa 11 sem os testes de carga, fase errada ou evidência velha bloqueiam o B9', () => {
  const casos = [
    [{ status: { 7: 'REPROVADA' } }, /etapa 7: REPROVADA/],
    [{ status: { 11: 'BLOQUEADA' } }, /etapa 11: BLOQUEADA/],
    [{ logEtapa11: `✔ ${CARGA} (1ms)\n` }, /p95 dos painéis/],
    [{ logEtapa11: `✖ ${CARGA}\n✔ m9d699 p95 dos painéis dentro das metas sob a carga\n` }, /dashboard pesado/],
    [{ fase: 'promocao' }, /fase/],
    [{ fim: '2020-01-01T00:00:00.000Z' }, /mais de 24 h/],
  ];
  for (const [cfg, esperado] of casos) {
    const e = montarEsteira(cfg);
    try {
      const r = avaliarEsteira({ dir: e.dir });
      assert.equal(r.ok, false, JSON.stringify(cfg));
      assert.match(r.motivos.join('\n'), esperado);
    } finally { e.limpar(); }
  }
  const velha = montarEsteira({ fim: '2020-01-01T00:00:00.000Z' });
  try { assert.equal(avaliarEsteira({ dir: velha.dir, idadeMaximaHoras: 1e6 }).ok, true, 'a idade máxima é parâmetro'); } finally { velha.limpar(); }
  assert.equal(avaliarEsteira({ dir: path.join(__dirname, 'nao-existe-m9d706') }).ok, false, 'sem evidência não fecha');
});

test('m9d706 o B9 com todas as demandas verificadas só fecha se a esteira estiver aprovada', () => {
  const fonte = montarFonte({ status: tudoVerificada });
  const boa = montarEsteira();
  const ruim = montarEsteira({ status: { 11: 'REPROVADA' } });
  try {
    const d = carregarDemandas(fonte.dir);
    const mapa = lerMapa(d.get('M9-D706').texto);
    const b9 = (esteira) => estadoDosSprints(mapa, d, { esteira }).find((s) => s.codigo === 'B9');
    assert.equal(b9({ dir: boa.dir }).estado, 'fechado');
    const r = b9({ dir: ruim.dir });
    assert.equal(r.estado, 'em andamento');
    assert.match(r.motivos.join(), /etapa 11/);
    const cli = (dir) => spawnSync(process.execPath, [SCRIPT, '--demandas', fonte.dir, '--esteira', dir], { encoding: 'utf8' });
    assert.equal(cli(boa.dir).status, 0);
    assert.match(cli(boa.dir).stdout, /^B9 .*fechado/m);
    assert.match(cli(ruim.dir).stdout, /^B9 .*em andamento/m);
  } finally { fonte.limpar(); boa.limpar(); ruim.limpar(); }
});
