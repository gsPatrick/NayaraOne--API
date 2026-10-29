'use strict';

// Suíte adversarial da NAY (M9-D042), teste 13 do livro. Dona: M9-D033. Perfis sandbox-a e sandbox-b; banco descartável, rollback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../../_helpers/advFixtures');
const G = require('../../_helpers/iaGolden');

let tenantA; let criador; let disparador;
before(async () => {
  ({ tenantA } = await F.empresas());
  [criador, disparador] = [G.ctxDe(tenantA).userId, G.ctxDe(tenantA).userId];
});
after(async () => { await F.sequelize.close(); });

const CATEGORIAS_OBRIGATORIAS = ['GROUNDING', 'HALLUCINATION', 'TOOL_SELECTION', 'PERMISSIONS', 'COST', 'LATENCY'];

test('adv_troca_de_provider_golden_continua_verde', async () => {
  await F.withRollbackTenantTransaction(tenantA, async (tx) => {
    const { code } = await G.criarAgente(tenantA, tx, criador);
    await G.cadastrarSeis(G.como(tenantA, criador), code, tx);
    for (const providerCode of ['sandbox-a', 'sandbox-b']) {
      const ev = await G.avaliar(G.svc, G.como(tenantA, disparador, 'ai:evaluate'), tx, { agentCode: code, suite: 'golden', providerCode });
      assert.equal(ev.status, 'PASSED', `${providerCode}: ${JSON.stringify(ev.metrics)}`);
      assert.equal(ev.providerCode, providerCode);
      for (const categoria of CATEGORIAS_OBRIGATORIAS) {
        assert.equal(ev.metrics[categoria].ok, true, `${providerCode} ${categoria}`);
        if (ev.metrics[categoria].pct !== undefined) assert.equal(ev.metrics[categoria].pct, '100.00', `${providerCode} ${categoria} precisa de 100%`);
      }
    }
  });
});
