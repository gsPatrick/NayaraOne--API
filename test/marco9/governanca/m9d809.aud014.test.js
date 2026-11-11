'use strict';

// M9-D809 — AUD-014 (JUR-006): garantia rastreável. A garantia substituída continua no histórico (nunca apagada, ligada à nova) e o vencimento da vigente aparece no calendário
// como item GUARANTEE aberto; o item da substituída fecha. Banco descartável, dentro de transação com rollback.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d802Env');
const { locacaoAtiva } = require('../_helpers/m9d809Lease');
const guaranteesService = require('../../../src/features/legal/guarantees.service');
const { Guarantee } = require('../../../src/models');

require('../../../src/features/core-governance'); // carrega o módulo como em produção: registra o projetor no outbox
let tenants;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (env.DISPOSABLE) tenants = await env.loadTenants(); });
after(async () => { await env.sequelize.close(); });

test('m9d809 AUD-014 garantia substituída mantém histórico e o vencimento aparece no calendário', { skip: skip() }, async () => {
  const t = tenants.A;
  await env.withRollbackTenantTransaction(t, async (tx) => {
    const { contract } = await locacaoAtiva(t, tx);
    const antiga = await guaranteesService.createGuarantee(contract.id, await require('../../m5fech.locacao.helpers').completeInsurance(t, tx, { value: 1000, startsAt: '2026-01-01', endsAt: '2027-02-28', renewalDueAt: '2027-01-31', status: 'ACTIVE' }), t.userId, tx);
    await env.drain(t, tx);
    const itemAntigo = await env.itemOf(t, 'GUARANTEE', antiga.id, tx);
    assert.equal(itemAntigo.status, 'OPEN', 'a garantia vigente abre o item de vencimento no calendário');
    assert.equal(itemAntigo.source_kind, 'LEGAL_GUARANTEE');

    const { oldGuarantee, newGuarantee } = await guaranteesService.replaceGuarantee(antiga.id, { guaranteeType: 'INSURANCE', value: 2000, startsAt: '2027-03-01', endsAt: '2028-02-28' }, t.userId, tx);
    await env.drain(t, tx);

    // histórico preservado: a antiga continua gravada, ligada à nova, com os dados originais e fora da vigência
    const relida = await Guarantee.findByPk(antiga.id, { transaction: tx });
    assert.ok(relida, 'a garantia substituída nunca é apagada');
    assert.equal(relida.replacedByGuaranteeId, newGuarantee.id);
    assert.equal(oldGuarantee.id, antiga.id);
    assert.notEqual(relida.status, 'ACTIVE');
    assert.equal(Number(relida.value), 1000, 'valor original preservado');
    const todas = await guaranteesService.listGuarantees(tx, { contractId: contract.id });
    assert.deepEqual(todas.map((g) => g.id).sort(), [antiga.id, newGuarantee.id].sort(), 'as duas aparecem no histórico do contrato');

    // calendário: item GUARANTEE aberto para a garantia vigente (com o novo vencimento) e o da substituída fechado
    const itemNovo = await env.itemOf(t, 'GUARANTEE', newGuarantee.id, tx);
    assert.ok(itemNovo, 'a garantia vigente tem item no calendário');
    assert.equal(itemNovo.status, 'OPEN');
    assert.equal(new Date(itemNovo.due_at).toISOString(), '2028-02-29T02:59:59.000Z', 'vencimento 28/02/2028 às 23:59:59 de Brasília');
    assert.notEqual((await env.itemOf(t, 'GUARANTEE', antiga.id, tx)).status, 'OPEN', 'o item da garantia substituída fecha');
    assert.equal(await env.countItems(t, 'GUARANTEE', newGuarantee.id, tx), 1);
  });
});
