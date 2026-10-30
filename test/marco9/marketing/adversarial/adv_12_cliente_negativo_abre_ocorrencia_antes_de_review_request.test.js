'use strict';

// M9-D437 adv_12 (Caderno §16: "Cliente negativo -> abre ocorrência antes de review request"). Nota 2 de satisfação: o pedido fica BLOCKED_NEGATIVE com a ocorrência aberta antes (e vinculada),
// nenhuma mensagem de avaliação sai, não há evento review.requested; uma nota positiva logo depois, com a ocorrência ainda aberta, também não pede avaliação. Cenário da dona (M9-D424). Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const { withRollbackTenantTransaction } = require('../../../testHelpers');
const rv = require('../../_helpers/mktReviews');
const adv = require('../../_helpers/mktAdv');

let tenant;
let offVault;
before(async () => { ({ tenantA: tenant } = await rv.prepararTenants()); offVault = rv.useTempSecretStore(); });
after(async () => { offVault(); await sequelize.close(); });
const SANDBOX = { mode: 'SANDBOX' };

test('adv_12_cliente_negativo_abre_ocorrencia_antes_de_review_request: nota 2 bloqueia o pedido, abre a ocorrência e nada sai', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const person = await rv.ready(t, tenant);
    const { out } = await rv.record(t, tenant, person, 2, SANDBOX);
    const [request] = await rv.requestOf(t, person);
    // (1) o efeito proibido não ocorreu: zero mensagem de avaliação, zero evento review.requested, zero link
    assert.equal(request.status, 'BLOCKED_NEGATIVE');
    assert.equal(request.satisfaction_score, 2);
    assert.equal((await rv.messagesOf(t, person)).length, 0, 'nenhuma mensagem de avaliação');
    assert.equal((await rv.reviewEvents(t, request.id)).length, 0, 'nenhum review.requested');
    assert.equal(out.runs[0].status, 'COMPLETED');
    // (2) o motivo foi registrado: a ocorrência existe, está aberta, é da pessoa e já consta no pedido ao ser registrado
    assert.ok(request.feedback_case_id, 'ocorrência vinculada ao pedido');
    const [kase] = await rv.q(t, 'SELECT status, type, person_id FROM crm.feedback_cases WHERE id = :id', { id: request.feedback_case_id });
    assert.deepEqual([kase.status, kase.type, kase.person_id], ['OPEN', 'COMPLAINT', person]);
    // "antes": o pedido nasce já com o id da ocorrência (a linha é inserida com feedback_case_id), então a ocorrência existia quando o pedido foi registrado
    assert.equal(request.feedback_case_id, (await rv.q(t, 'SELECT id FROM crm.feedback_cases WHERE person_id = :p', { p: person }))[0].id);
    // uma nota positiva com a ocorrência ainda aberta também não pede avaliação
    const second = await rv.record(t, tenant, person, 5, SANDBOX);
    const requests = await rv.requestOf(t, person);
    assert.ok(requests.every((r) => r.status !== 'SENT'), 'nenhum pedido enviado enquanto a ocorrência está aberta');
    assert.equal((await rv.messagesOf(t, person)).length, 0, 'continua sem mensagem');
    assert.notEqual(second.out.runs[0].status, 'FAILED');
    // isolamento (RLS): a outra empresa não enxerga o pedido nem a ocorrência
    await adv.assertIsolated(t, tenant, [{ tabela: 'marketing.review_requests', ids: [request.id] }, { tabela: 'crm.feedback_cases', ids: [request.feedback_case_id] }]);
  });
});
