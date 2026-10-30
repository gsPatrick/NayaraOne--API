'use strict';

const { Op } = require('sequelize');
const { sequelize, InsurancePolicy, OutboxEvent } = require('../../../models');
const { readInsuranceParams } = require('./insurance.params');
const { publishPolicyExpiring, publishPolicyExpired, expiringKey } = require('./insurance.events');
const { startRenewalQuote } = require('./insurance.renewal');

const LIVE_STATUSES = ['ACTIVE', 'ISSUED'];
const ymd = (v) => String(v).slice(0, 10);
const daysBetween = (fromYmd, toYmd) => Math.round((Date.UTC(+toYmd.slice(0, 4), +toYmd.slice(5, 7) - 1, +toYmd.slice(8, 10)) - Date.UTC(+fromYmd.slice(0, 4), +fromYmd.slice(5, 7) - 1, +fromYmd.slice(8, 10))) / 86400000);

/**
 * O marco do dia: o MENOR marco configurado que ainda cobre os dias que faltam (60, 30, 15 e 7 por padrão). Com 60 dias exatos é o 60; com 59 continua o 60 (o mesmo fato,
 * sem duplicar); com 30 passa a ser o 30. Mais de 60 dias, ou vigência já encerrada, não tem marco. Apólice emitida com 10 dias de vigência emite o marco 15 uma vez.
 */
function milestoneFor(daysLeft, marcos) {
  if (daysLeft < 0) return null;
  const cobertos = marcos.filter((m) => m >= daysLeft).sort((a, b) => a - b);
  return cobertos.length ? cobertos[0] : null;
}

/**
 * publishDueMilestones — publica `insurance.policy.expiring` para cada apólice vigente que entrou numa faixa de alerta (M9-D238 3.4) e dispara a cotação de renovação quando a
 * apólice chega ao prazo configurado. Idempotente por (apólice, fim da vigência, marco): rodar de novo no mesmo dia, ou todos os dias da faixa, não duplica. `today`: AAAA-MM-DD
 * em America/Sao_Paulo. Devolve { checked, published, renewalQuotes }.
 */
async function publishDueMilestones(transaction, today) {
  const policies = await InsurancePolicy.findAll({ where: { status: { [Op.in]: LIVE_STATUSES }, expiryDate: { [Op.ne]: null } }, transaction });
  const summary = { checked: policies.length, published: 0, renewalQuotes: 0 };
  const paramsPorEmpresa = new Map();
  for (const policy of policies) {
    if (!paramsPorEmpresa.has(policy.companyId)) paramsPorEmpresa.set(policy.companyId, await readInsuranceParams({ groupId: policy.groupId, companyId: policy.companyId }, transaction));  
    const params = paramsPorEmpresa.get(policy.companyId);
    const daysLeft = daysBetween(today, ymd(policy.expiryDate));
    const marco = milestoneFor(daysLeft, params.renewalAlertDays);
    if (marco === null) continue;  
     
    const jaPublicado = await OutboxEvent.count({ where: { idempotencyKey: expiringKey(policy, marco) }, transaction });
    if (!jaPublicado) {
      await publishPolicyExpiring(policy, { marco, daysToExpiry: daysLeft }, transaction);  
      summary.published += 1;
    }
    if (params.renewalQuoteEnabled && daysLeft <= params.renewalQuoteDays) {
       
      const r = await sequelize.transaction({ transaction }, (savepoint) => startRenewalQuote(policy, savepoint));
      if (r.started) summary.renewalQuotes += 1;
    }
  }
  return summary;
}

/** `insurance.policy.expired` da apólice que o job de vencimento acabou de encerrar (no dia seguinte ao fim da vigência). */
const publishExpired = (policy, transaction) => publishPolicyExpired(policy, transaction);

module.exports = { publishDueMilestones, publishExpired, milestoneFor, daysBetween };
