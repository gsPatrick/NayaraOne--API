'use strict';

// Suíte adversarial da NAY (M9-D042), teste 7 do livro. Dona: M9-D013. Provider sandbox, banco descartável, rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../../_helpers/advFixtures');
const FB = require('../../_helpers/iaFallback');
const { definirParametro } = require('../../_helpers/iaOrcamento');

let tenantA;
before(async () => { ({ tenantA } = await F.empresas()); });
after(async () => { await F.sequelize.close(); });

const MENSAGEM = 'A NAY não está disponível agora. Nenhuma ação foi executada.';
const principal = FB.linha('prov-a', { pricePerMTokIn: 1, pricePerMTokOut: 1 });
const equivalente = FB.linha('prov-b', { pricePerMTokIn: 2, pricePerMTokOut: 2 });
const inferior = FB.linha('prov-b', { pricePerMTokIn: 2, pricePerMTokOut: 2, safetyTier: 2 });

async function cenario(tx, linhas) {
  await definirParametro(tenantA, 'ia.fallback.exigir_avaliacao_verde', false, tx);
  const registro = FB.registroFalso(linhas, { falham: { 'prov-a': 'UNAVAILABLE' } }); // o modelo cai: [[FALHA:UNAVAILABLE]]
  return { registro, c: await F.H.cenario(tenantA, tx, { deps: FB.depsDoRegistro(registro) }) };
}
const classificar = (c) => F.H.rodar(c, 'Classifique [[RESPOSTA:Tipo comercial.]]', { taskType: 'classificar' });

test('adv_modelo_cai_fallback_seguro_ou_falha_fechada', async () => {
  await F.withRollbackTenantTransaction(tenantA, async (tx) => {
    // Com candidato seguro: 200 pelo fallback registrado no run.
    const seguro = await cenario(tx, [principal, equivalente]);
    const ok = await classificar(seguro.c);
    assert.equal(ok.ok, true, JSON.stringify(ok.error));
    assert.equal(ok.provider, 'prov-b');
    const run = await F.H.lerRun(ok.runId, tx);
    assert.equal(run.fallback_trail.length, 1);
    assert.equal(run.fallback_trail[0].reason, 'UNAVAILABLE');
    // Sem candidato seguro: 503 AI_FALLBACK_UNSAFE e nenhum efeito colateral (o inferior nunca é chamado).
    const fechado = await cenario(tx, [principal, inferior]);
    const r = F.H.falhou(await classificar(fechado.c), 503, 'AI_FALLBACK_UNSAFE', 'FAILED');
    assert.equal(r.error.message, MENSAGEM);
    assert.deepEqual(fechado.registro.chamadas.map((x) => x.code), ['prov-a']);
    assert.equal((await F.H.chamadas(r.runId, tx)).length, 0, 'nenhuma tool rodou');
  });
});
