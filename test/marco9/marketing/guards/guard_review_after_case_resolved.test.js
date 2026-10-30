'use strict';

// M9-D440 guard_review_after_case_resolved (Guia §14: "Não pedir review positivo para cliente insatisfeito sem tratar ocorrência"). Estática: o pedido confere ocorrência aberta antes de criar e de
// enviar. Dinâmica: com ocorrência aberta a nota positiva não gera pedido nem chama o canal (espião); resolvida a ocorrência, só uma nova nota positiva gera o pedido.
const { test, before, afterEach, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const { withRollbackTenantTransaction } = require('../../../testHelpers');
const rv = require('../../_helpers/mktReviews');
const g = require('../../_helpers/mktGuardas');

const NOME = 'guard_review_after_case_resolved';
const SANDBOX = { mode: 'SANDBOX' };
let tenant;
let offVault;
let espiao;
before(async () => { ({ tenantA: tenant } = await rv.prepararTenants()); offVault = rv.useTempSecretStore(); });
beforeEach(() => { espiao = g.espiarCanais(); });
afterEach(() => espiao.restaurar());
after(async () => { offVault(); await sequelize.close(); });
const inTx = (fn) => withRollbackTenantTransaction(tenant, fn);

test('guard_review_after_case_resolved: o pedido de avaliação confere ocorrência aberta antes de criar e de enviar', () => {
  g.assertSemViolacao(NOME);
});

test('guard_review_after_case_resolved: pedido sem a conferência da ocorrência é achado com arquivo e linha', () => {
  const copia = g.copiaDoModulo([{ arquivo: 'src/features/marketing/automations/reviews/review.positive.js', de: 'if (await repo.hasOpenCase(input.personId, input.transaction)) return { reviewRequestId: null', para: 'if (false) return { reviewRequestId: null' }]);
  try {
    const achados = g.violacoesDe(NOME, copia);
    assert.deepEqual(achados.map((a) => a.arquivo), ['automations/reviews/review.positive.js']);
    assert.match(achados[0].regra, /positive deve conferir ocorrência aberta/);
  } finally { require('node:fs').rmSync(copia, { recursive: true, force: true }); }
});

test('guard_review_after_case_resolved: com ocorrência aberta a nota positiva não gera pedido e o canal não é chamado; resolvida, só a nova nota positiva pede a avaliação', async () => {
  await inTx(async (t) => {
    const person = await rv.ready(t, tenant);
    const kase = await rv.openCase(t, tenant, person);
    await rv.record(t, tenant, person, 5, SANDBOX);
    assert.equal((await rv.requestOf(t, person)).length, 0, 'nenhum pedido nasce');
    assert.equal((await rv.messagesOf(t, person)).length, 0);
    assert.equal(espiao.envios().length, 0, 'o adapter não foi chamado');
    await rv.q(t, "UPDATE crm.feedback_cases SET status = 'RESOLVED' WHERE id = :id RETURNING id", { id: kase.id });
    assert.equal((await rv.requestOf(t, person)).length, 0, 'resolver a ocorrência não pede nada sozinho');
    await rv.record(t, tenant, person, 5, SANDBOX);
    assert.deepEqual((await rv.requestOf(t, person)).map((r) => r.status), ['SENT']);
    assert.equal(espiao.envios('EMAIL').length, 1);
  });
});

test('guard_review_after_case_resolved: a nota negativa abre a ocorrência antes e não pede avaliação', async () => {
  await inTx(async (t) => {
    const person = await rv.ready(t, tenant);
    await rv.record(t, tenant, person, 1, SANDBOX);
    const [request] = await rv.requestOf(t, person);
    assert.equal(request.status, 'BLOCKED_NEGATIVE');
    assert.ok(request.feedback_case_id);
    assert.equal(espiao.envios().length, 0);
  });
});
