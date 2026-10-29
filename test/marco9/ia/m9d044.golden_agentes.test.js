'use strict';

// M9-D044 — estágios 8 (grounding golden set) e 9 (hallucination tests) da esteira da NAY: o golden da categoria de TODOS os agentes definidos
// em código tem de dar 100%. A esteira roda um por vez (AI_CI_GOLDEN_CATEGORIA=GROUNDING | HALLUCINATION); sem a variável, roda os dois.
// Banco descartável, role nayara_runtime, rollback; provider sandbox.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { AiEvaluationService } = require('../../../src/features/ai/evaluations');
const { registerAiAdapters } = require('../../../src/features/ai/providers');
const H = require('../_helpers/iaAvaliacao');
const S = require('../_helpers/iaAgentesDoSistema');

const CATEGORIAS = process.env.AI_CI_GOLDEN_CATEGORIA ? [process.env.AI_CI_GOLDEN_CATEGORIA] : ['GROUNDING', 'HALLUCINATION'];
const svc = new AiEvaluationService();
let tenantA;
before(async () => { ({ tenantA } = await H.prepararTenants()); await H.carregarPessoas(); registerAiAdapters(); });
after(async () => { await H.sequelize.close(); });

test('m9d044_todo_agente_nay_define_codigo', () => {
  const lista = S.agentesDoCodigo();
  assert.ok(lista.length >= 8, `esperados os agentes da NAY em src/features/ai/agents/nay_*; vieram ${lista.map((a) => a.pasta).join(', ')}`);
  for (const a of lista) assert.match(String(a.code), /^NAY_[A-Z_]+$/, `${a.pasta}: sem código de agente`);
});

for (const categoria of CATEGORIAS) {
  test(`m9d044_golden_${categoria.toLowerCase()}_de_todos_os_agentes_a_100_por_cento`, async () => {
    await withRollbackTenantTransaction(tenantA, async (tx) => {
      const ctx = { ...H.ctxDe(tenantA), permissions: ['ai:evaluate'] };
      const reprovados = [];
      for (const agente of S.agentesDoCodigo()) {
        await S.cadastrar(H.ctxDe(tenantA), agente, tx);
        const ev = await H.avaliar(svc, ctx, tx, { agentCode: agente.code, suite: 'golden' });
        const itens = ev.items.filter((i) => i.category === categoria);
        const m = ev.metrics[categoria];
        if (!itens.length) reprovados.push(`${agente.code}: sem caso de ${categoria} no golden`);
        else if (!m || m.pct !== '100.00' || itens.some((i) => !i.passed)) reprovados.push(`${agente.code}: ${categoria} em ${m && m.pct}% (${itens.filter((i) => !i.passed).map((i) => i.caseId).join(', ')})`);
      }
      assert.deepEqual(reprovados, [], `golden ${categoria} abaixo de 100%`);
    });
  });
}
