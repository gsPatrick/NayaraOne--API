'use strict';

// M9-D416 — conditions avaliadas pelo Motor de Regras sobre os facts do CRM, fail-closed. Banco descartável; ver m9d416.cap.test.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const { evaluateAutomationPolicy } = require('../../../src/features/marketing/automations/policy');
const { buildAutomationFacts } = require('../../../src/features/marketing/automations/facts');
const env = require('../_helpers/mktPolicyEnv');
const { proximoDiaDaSemana, instante } = require('../_helpers/relogioRelativo');

const { readyPerson, makeFlowVersion, publishRule, makeOpportunity, makeRadar, addMessage, addConsent, uid } = env;
let A;
let B;
before(async () => { ({ a: A, b: B } = await env.tenants()); });
after(async () => { await sequelize.close(); });
const run = (fn) => withRollbackTenantTransaction(A, fn);
// Segunda-feira 17:00Z ao menos 4 dias à frente da execução: os registros gravados agora ficam antes dela.
const DIA = proximoDiaDaSemana(1, 4);
const NOW = instante(DIA, '17:00:00');
const policy = (t, personId, conditions) => evaluateAutomationPolicy(
  { version: { flowId: uid(), conditions, cooldown: { amount: 1, unit: 'HOURS' } }, subject: { type: 'PERSON', id: personId }, channel: 'WHATSAPP', now: NOW }, A, t);

test('regra_inexistente_nao_envia', async () => {
  await run(async (t) => {
    const personId = await readyPerson(t, A);
    const decision = await policy(t, personId, [`QA-M9-INEXISTENTE-${uid().slice(0, 6)}`]);
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'CONDITION_ERROR');
    assert.equal(decision.code, 'MKT_CONDITION_ERROR');
    assert.equal(decision.message, 'Não foi possível avaliar as condições.');
  });
});

test('condicoes_avaliadas_pelo_motor_de_regras_todas_precisam_ser_verdadeiras', async () => {
  await run(async (t) => {
    const personId = await readyPerson(t, A);
    await makeOpportunity(t, A, personId, { stage: 'NEGOTIATION' });
    const stage = `QA-M9-ESTAGIO-${uid().slice(0, 6)}`;
    const other = `QA-M9-OUTRO-${uid().slice(0, 6)}`;
    const broken = `QA-M9-QUEBRADA-${uid().slice(0, 6)}`;
    await publishRule(t, A, stage, { fact: 'leadStage', op: '==', value: 'NEGOTIATION' });
    await publishRule(t, A, other, { fact: 'leadStage', op: '==', value: 'NEW' });
    await publishRule(t, A, broken, { fact: 'leadStage', op: 'CONTEM', value: 'N' }); // operador inválido: erro do motor

    const ok = await policy(t, personId, [stage]);
    assert.equal(ok.allowed, true);
    assert.deepEqual(ok.trace.map((x) => [x.ruleCode, x.decision]), [[stage, 'APPLY']]);
    const falsy = await policy(t, personId, [stage, other]);
    assert.equal(falsy.reason, 'CONDITION_FALSE', 'basta uma regra falsa');
    assert.equal(falsy.code, 'MKT_CONDITION_FALSE');
    assert.equal(falsy.ruleCode, other);
    const err = await policy(t, personId, [stage, broken]);
    assert.equal(err.reason, 'CONDITION_ERROR', 'erro de avaliação é fail-closed, não falso');
    assert.equal((await policy(t, personId, [])).allowed, true, 'sem condições (justificado na versão) passa');
    const flow = await makeFlowVersion(t, A, { conditions: [stage] });
    assert.deepEqual(flow.conditions, [stage]);
  });
});

test('facts_trazem_so_campos_seguros_do_crm', async () => {
  await run(async (t) => {
    const personId = await readyPerson(t, A);
    await makeOpportunity(t, A, personId, { stage: 'VISIT', temperature: 'HOT' });
    await makeRadar(t, A, personId, { propertyTypes: ['APARTMENT', 'HOUSE'] });
    await makeRadar(t, A, personId, { propertyTypes: ['LAND'] }, 'PAUSED');
    await addMessage(t, A, { personId, channel: 'WHATSAPP', direction: 'INBOUND', status: 'RECEIVED', at: instante(DIA, '17:00:00', -5) });
    await addConsent(t, A, personId, 'WHATSAPP', 'RADAR', 'OPT_OUT', instante(DIA, '17:00:00', -8));
    const facts = await buildAutomationFacts({ type: 'PERSON', id: personId }, A, t, NOW);
    assert.equal(facts.leadStage, 'VISIT');
    assert.equal(facts.leadTemperature, 'HOT');
    assert.equal(facts.daysSinceContact, 5);
    assert.deepEqual(facts.interests.sort(), ['APARTMENT', 'HOUSE']);
    assert.equal(facts.consents.WHATSAPP.MARKETING, 'OPT_IN');
    assert.equal(facts.consents.WHATSAPP.RADAR, 'OPT_OUT');
    assert.equal(facts.lastProposalValue, null);
    const text = JSON.stringify(facts);
    assert.ok(!/987654321|@exemplo/.test(text), 'nenhum endereço de contato nos facts');
    const empty = await buildAutomationFacts({ type: 'COMPANY', id: uid() }, A, t, NOW);
    assert.equal(empty.leadStage, null);
  });
});

test('regra_de_outra_empresa_nao_vale', async () => {
  await run(async (t) => {
    const personId = await readyPerson(t, A);
    const code = `QA-M9-ISOLADA-${uid().slice(0, 6)}`;
    await env.asTenant(t, A, B, () => publishRule(t, B, code, { fact: 'leadStage', op: '==', value: 'NEW' }));
    assert.equal((await policy(t, personId, [code])).reason, 'CONDITION_ERROR');
  });
});
