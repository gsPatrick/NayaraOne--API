'use strict';

// M9-D034 capacidade 3 — listar os imóveis do Radar: só apresenta o que o Radar já calculou, no máximo ia.comercial.radar_max_imoveis,
// ordenados pela pontuação do Radar, cada um com fonte e motivo; o aviso "há mais N" quando passa do limite; a tool devolve o mesmo.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { definirParametro } = require('../_helpers/iaOrcamento');
const C = require('../_helpers/iaComercial');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

test('m9d034_lista_radar_ate_10_com_motivo', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await C.cenario(tenantA, tx);
    await C.radarComImoveis(c, 14);
    const { outcome: o } = await c.pedir('listar_imoveis_radar', 'Liste os imóveis do Radar');
    assert.equal(o.ok, true, JSON.stringify(o.error));
    assert.equal(o.routingPath, 'RULE');
    assert.equal(o.structured.total, 14);
    assert.equal(o.structured.exibidos, 10, 'o padrão é 10 imóveis');
    assert.equal(o.structured.haMais, 4);
    assert.match(o.answer, /Há mais 4 imóveis além dos 10 listados/);
    assert.equal(o.structured.imoveis.length, 10);
    for (const m of o.structured.imoveis) {
      assert.match(m.reason, /^Atende: /, 'cada imóvel traz o motivo do match');
      assert.equal(typeof m.score, 'number');
    }
    const scores = o.structured.imoveis.map((m) => m.score);
    assert.deepEqual([...scores].sort((a, b) => b - a), scores, 'ordenado pela pontuação do Radar');
    assert.deepEqual(o.sources.map((s) => s.title), ['radar.matches', 'properties']);
    assert.ok(o.snapshotAt);
    // O limite é parâmetro da empresa.
    await definirParametro(tenantA, 'ia.comercial.radar_max_imoveis', 3, tx);
    const { outcome: tres } = await c.pedir('listar_imoveis_radar', 'Liste os imóveis do Radar');
    assert.equal(tres.structured.exibidos, 3);
    assert.equal(tres.structured.haMais, 11);
  });
});

test('m9d034_radar_sem_imoveis_e_tool_devolve_o_mesmo_com_o_limite_da_empresa', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const c = await C.cenario(tenantA, tx);
    const { outcome: vazio } = await c.pedir('listar_imoveis_radar', 'Liste os imóveis do Radar');
    assert.match(vazio.answer, /não tem imóveis compatíveis/);
    assert.equal(vazio.structured.total, 0);
    await C.radarComImoveis(c, 5);
    await definirParametro(tenantA, 'ia.comercial.radar_max_imoveis', 2, tx);
    const { outcome: viaTool } = await c.pedir('consulta', `Liste [[TOOL:radar.listMatchesForOpportunity:{"opportunityId":"${c.opp.id}"}]] [[RESPOSTA:O Radar tem imóveis compatíveis [1].]]`);
    assert.equal(viaTool.ok, true, JSON.stringify(viaTool.error));
    const [chamada] = await C.chamadasDe(viaTool.runId, tx);
    assert.deepEqual(chamada, { tool_name: 'radar.listMatchesForOpportunity', status: 'SUCCEEDED' });
    const [fonte] = await sequelize.query('SELECT excerpt FROM ai.ai_sources WHERE ai_run_id = :id ORDER BY retrieved_at LIMIT 1', { replacements: { id: viaTool.runId }, transaction: tx, type: 'SELECT' });
    assert.match(fonte.excerpt, /"total":5/);
    assert.match(fonte.excerpt, /"hasMore":true/);
  });
});
