'use strict';

// Ponto 5 do aceite do Marco 9 (DI-M9R-2): o bloqueio do envio da CAMPANHA para quem fez opt-out (ou não deu consentimento) fica
// visível por destinatário, na trilha, com a mesma ação do envio avulso (`marketing.message.blocked` sobre a pessoa, M9-D429):
// status BLOCKED, motivo (SUPPRESSED/OPT_OUT/NO_CONSENT) e "não enviada". Quem recebeu não ganha linha de bloqueio, e reprocessar
// o step não duplica a linha. Antes, o motivo ficava só em marketing.campaign_step_deliveries, sem rota nem trilha.
// Banco descartável; transação com rollback; adapter simulado (o canSend é o real).

const { test, before, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const campaigns = require('../../../src/features/marketing/campaigns/campaigns.service');
const lifecycle = require('../../../src/features/marketing/campaigns/lifecycle.service');
const { registerCampaignSendPort, clearCampaignSendPort } = require('../../../src/features/marketing/campaigns/sendPort');
const { buildCampaignSendPort } = require('../../../src/features/marketing/suppression/campaignPort');
const consents = require('../../../src/features/people/personConsents.service');
const env = require('../_helpers/mktPolicyEnv');

const { readyPerson, makeTemplate, completeBody, q } = env;
let A;
before(async () => { ({ a: A } = await env.tenants()); });
afterEach(() => clearCampaignSendPort());
after(async () => { await sequelize.close(); });
const START = '2031-12-01T09:00:00';
const TICK = new Date('2031-12-01T12:00:10Z'); // 09:00:10 em São Paulo, fora do silêncio

const blockedAudits = (t, personIds) => q(t, `SELECT entity_type, entity_id, user_id, after_json, reason FROM audit.audit_log
  WHERE company_id = :c AND action = 'marketing.message.blocked' AND entity_id IN (:ids) ORDER BY created_at, id`, { c: A.companyId, ids: personIds });

test('destinatario_com_opt_out_ou_sem_consentimento_tem_a_mensagem_bloqueada_registrada_na_trilha_e_nada_enviado', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const comConsentimento = await readyPerson(t, A);
    const optOut = await readyPerson(t, A);
    const semConsentimento = await readyPerson(t, A, { optIn: [] });
    // opt-out registrado como na ficha (histórico de consentimento): cria a supressão na mesma transação (M9-D419)
    await consents.recordConsent(optOut, { channel: 'EMAIL', purpose: 'MARKETING', status: 'OPT_OUT' }, A.userId, t);
    const enviados = [];
    registerCampaignSendPort(buildCampaignSendPort({ send: async (ctx) => { enviados.push(ctx.personId); return { ok: true, externalRef: `msg-${enviados.length}` }; } }));

    const templateId = await makeTemplate(t, A);
    const ids = [comConsentimento, optOut, semConsentimento];
    const body = completeBody({ templateId, personIds: ids, startsAt: START, endsAt: '2031-12-10T18:00:00', audiences: [{ kind: 'PERSON_LIST', purpose: 'MARKETING', filter: { personIds: ids } }] });
    const { campaign } = await campaigns.saveCampaign(A, A.userId, { ...body, schedule: true }, { permissions: ['marketing:campaign:manage'] }, t);
    await lifecycle.runLifecycleTick(A, t, TICK);

    assert.deepEqual(enviados, [comConsentimento], 'só quem tem consentimento chega ao adapter');
    const linhas = await blockedAudits(t, ids);
    const porPessoa = Object.fromEntries(linhas.map((l) => [l.entity_id, l]));
    assert.equal(linhas.length, 2, `uma linha por destinatário bloqueado: ${JSON.stringify(linhas.map((l) => l.after_json.reason))}`);
    assert.equal(porPessoa[comConsentimento], undefined, 'quem recebeu não tem linha de bloqueio');

    const out = porPessoa[optOut];
    assert.ok(out, 'o opt-out tem a linha de bloqueio na trilha');
    assert.equal(out.entity_type, 'Person');
    assert.equal(out.user_id, null, 'quem bloqueia é a rotina da campanha');
    assert.ok(['SUPPRESSED', 'OPT_OUT'].includes(out.after_json.reason), out.after_json.reason);
    assert.equal(out.after_json.deliveryStatus, 'BLOCKED');
    assert.equal(out.after_json.sent, false);
    assert.equal(out.after_json.campaignId, campaign.id);
    assert.equal(out.after_json.channel, 'EMAIL');
    assert.equal(out.after_json.origin, 'CAMPAIGN_STEP');
    assert.match(out.reason, /não enviada: Esta pessoa pediu para não receber mensagens/);

    const sem = porPessoa[semConsentimento];
    assert.ok(sem, 'o contato sem consentimento tem a linha de bloqueio na trilha');
    assert.equal(sem.after_json.reason, 'NO_CONSENT');
    assert.equal(sem.after_json.code, 'MKT_NO_CONSENT');

    // a linha aponta a entrega gravada (BLOCKED com o mesmo motivo)
    const [entrega] = await q(t, 'SELECT status, reason FROM marketing.campaign_step_deliveries WHERE id = :id', { id: out.after_json.deliveryId });
    assert.deepEqual([entrega.status, entrega.reason], ['BLOCKED', out.after_json.reason]);

    // nenhuma mensagem do CRM para quem foi bloqueado
    const [{ n }] = await q(t, "SELECT count(*)::int AS n FROM crm.messages WHERE person_id IN (:p) AND direction = 'OUTBOUND'", { p: [optOut, semConsentimento] });
    assert.equal(n, 0);

    // reprocessar o mesmo step (outro ciclo) não duplica a linha
    await lifecycle.runLifecycleTick(A, t, new Date(TICK.getTime() + 60000));
    assert.equal((await blockedAudits(t, ids)).length, 2);
  });
});
