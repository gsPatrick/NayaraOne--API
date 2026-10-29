'use strict';

// M9-D013 — o seletor de equivalência segura ligado ao orquestrador (deps.fallbackSelector, padrão): a queda do principal conclui o run com
// `fallback_trail`, sem equivalente o run falha fechado (503, FAILED, ai.run.failed) e nenhuma tool roda depois da falha.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { sequelize, prepararTenants } = require('../../helpers/aiAgents');
const { definirParametro } = require('../_helpers/iaOrcamento');
const { eventos } = require('../_helpers/iaEventos');
const H = require('../_helpers/iaOrquestrador');
const F = require('../_helpers/iaFallback');
const { describeAvailable } = require('../../../src/features/ai/orchestrator/failClosed');

let tenantA;
before(async () => { ({ tenantA } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

const MENSAGEM = 'A NAY não está disponível agora. Nenhuma ação foi executada.';
const A = F.linha('prov-a', { pricePerMTokIn: 1, pricePerMTokOut: 1 });
const equivalente = () => F.linha('prov-b', { pricePerMTokIn: 2, pricePerMTokOut: 2 });
const inferior = () => F.linha('prov-b', { pricePerMTokIn: 2, pricePerMTokOut: 2, safetyTier: 2 });

async function cenario(tx, linhas, falham, over = {}) {
  await definirParametro(tenantA, 'ia.fallback.exigir_avaliacao_verde', false, tx);
  const registro = F.registroFalso(linhas, { falham });
  return { registro, c: await H.cenario(tenantA, tx, { deps: F.depsDoRegistro(registro), ...over }) };
}
const classificar = (c, texto = 'Classifique [[RESPOSTA:Tipo comercial.]]') => H.rodar(c, texto, { taskType: 'classificar' });

test('adv_modelo_cai_fallback_seguro_ou_falha_fechada', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    // Ramo 1: o principal cai e há equivalente: o run conclui no segundo modelo.
    const seguro = await cenario(tx, [A, equivalente()], { 'prov-a': 'UNAVAILABLE' });
    const ok = await classificar(seguro.c);
    assert.equal(ok.ok, true, JSON.stringify(ok.error));
    assert.equal(ok.provider, 'prov-b');
    assert.deepEqual(seguro.registro.chamadas.map((x) => x.code), ['prov-a', 'prov-b']);
    // Ramo 2: o principal cai e o único alternativo é menos seguro: falha fechada, sem efeito colateral.
    const fechado = await cenario(tx, [A, inferior()], { 'prov-a': 'UNAVAILABLE' });
    const r = H.falhou(await classificar(fechado.c), 503, 'AI_FALLBACK_UNSAFE', 'FAILED');
    assert.equal(r.error.message, MENSAGEM);
    assert.deepEqual(fechado.registro.chamadas.map((x) => x.code), ['prov-a'], 'o modelo inferior nunca foi chamado');
  });
});

test('m9d013_fallback_seguro', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    for (const kind of ['UNAVAILABLE', 'TIMEOUT', 'RATE_LIMIT']) {
      const { c, registro } = await cenario(tx, [A, equivalente()], { 'prov-a': kind });
      const res = await classificar(c);
      assert.equal(res.ok, true, `${kind}: ${JSON.stringify(res.error)}`);
      assert.equal(res.provider, 'prov-b');
      assert.equal(res.status, 'COMPLETED');
      assert.equal(registro.chamadas.length, 2);
    }
  });
});

test('m9d013_salto_registrado_no_run', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { c } = await cenario(tx, [A, equivalente()], { 'prov-a': 'UNAVAILABLE' });
    const res = await classificar(c);
    const run = await H.lerRun(res.runId, tx);
    assert.equal(run.provider_code, 'prov-b');
    assert.equal(run.model_code, 'prov-b-m');
    assert.equal(run.fallback_trail.length, 1);
    const [salto] = run.fallback_trail;
    assert.deepEqual({ from: salto.from, to: salto.to, reason: salto.reason }, { from: 'prov-a/prov-a-m', to: 'prov-b/prov-b-m', reason: 'UNAVAILABLE' });
    assert.equal(typeof salto.ms, 'number', 'o tempo da tentativa que falhou fica no salto');
    // Dois saltos seguidos (padrão 2): A cai, B cai, C responde.
    const tres = await cenario(tx, [A, equivalente(), F.linha('prov-c', { pricePerMTokIn: 3, pricePerMTokOut: 3 })], { 'prov-a': 'UNAVAILABLE', 'prov-b': 'TIMEOUT' });
    const dois = await classificar(tres.c);
    assert.equal(dois.ok, true, JSON.stringify(dois.error));
    assert.deepEqual((await H.lerRun(dois.runId, tx)).fallback_trail.map((s) => s.reason), ['UNAVAILABLE', 'TIMEOUT']);
    // Com ia.fallback.max_saltos = 1 o segundo salto não acontece: provedor indisponível.
    await definirParametro(tenantA, 'ia.fallback.max_saltos', 1, tx);
    const limite = await cenario(tx, [A, equivalente(), F.linha('prov-c', { pricePerMTokIn: 3, pricePerMTokOut: 3 })], { 'prov-a': 'UNAVAILABLE', 'prov-b': 'UNAVAILABLE' });
    H.falhou(await classificar(limite.c), 503, 'AI_PROVIDER_UNAVAILABLE', 'FAILED');
  });
});

test('m9d013_auth_nao_aciona_fallback', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    for (const kind of ['AUTH', 'VALIDATION', 'SAFETY_BLOCKED']) {
      const { c, registro } = await cenario(tx, [A, equivalente()], { 'prov-a': kind });
      const res = await classificar(c).then((x) => x, (e) => ({ ok: false, lancou: e }));
      assert.equal(res.ok, false, kind);
      assert.notEqual(res.error && res.error.code, 'AI_FALLBACK_UNSAFE');
      assert.deepEqual(registro.chamadas.map((x) => x.code), ['prov-a'], `${kind}: o segundo modelo não foi chamado`);
    }
  });
});

test('m9d013_falha_fechada_nao_executa_tool', async () => {
  await withRollbackTenantTransaction(tenantA, async (tx) => {
    const { c, registro } = await cenario(tx, [A, inferior()], { 'prov-a': 'UNAVAILABLE' });
    const res = H.falhou(await H.rodar(c, `Resuma ${H.pedirOportunidade(c)} [[RESPOSTA:ok]]`), 503, 'AI_FALLBACK_UNSAFE', 'FAILED');
    assert.equal((await H.chamadas(res.runId, tx)).length, 0, 'nenhuma tool executou');
    assert.equal(registro.chamadas.length, 1);
    assert.equal((await eventos('ai.run.failed', res.runId, tx)).length, 1, 'ai.run.failed publicado');
    const run = await H.lerRun(res.runId, tx);
    assert.equal(run.status, 'FAILED');
    assert.equal(run.error_code, 'AI_FALLBACK_UNSAFE');
  });
});

test('m9d013_falha_fechada_agente_critico_mantem_o_resultado_de_regra_sem_texto', () => {
  const payload = [{ ref: 'r1', label: 'Saldo', value: '10.00', source: 'financeiro' }];
  assert.deepEqual(describeAvailable({ agent: { criticality: 'CRITICAL' }, numbersPayload: payload }), { ruleResult: payload, generatedText: null });
  assert.equal(describeAvailable({ agent: { criticality: 'NON_CRITICAL' }, numbersPayload: payload }), null);
  assert.equal(describeAvailable({ agent: { criticality: 'CRITICAL' }, numbersPayload: [] }), null);
});
