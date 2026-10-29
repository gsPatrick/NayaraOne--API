'use strict';

/**
 * Marco 9, demanda M9-D627 (Caderno "Dashboards + BI + Centro de Comando", §11 KPIs Marketing/Atendimento): read models de Marketing e
 * Atendimento/Satisfação no schema analytics. Por EMPRESA, só ids e agregados (telefone, e-mail, nome e documento nunca entram).
 *
 *  rm_mkt_campaigns, rm_mkt_delivery, rm_mkt_frequency, rm_mkt_reviews, rm_mkt_automation,
 *  rm_support_satisfaction, rm_support_complaints, rm_support_sla
 *
 * O worker (M9-D607) chama `recompute` com o ESTADO atual da fonte (nunca delta), idempotente por sourceEventId; a agenda reconfere o que
 * muda sem evento; o rebuild (M9-D608) enumera todos os agregados das fontes. Só os serviços de métrica leem estas tabelas (M9-D613).
 * M9-D670 e M9-D671 acrescentam rm_mkt_campaign_month e rm_mkt_optout_month (marketingKpi.*.js), por mês.
 * Eventos: catálogo do Marketing (M9-D434), crm.feedback_case.* e o status de entrega de crm.messages (crm.interaction.recorded e
 * crm.message.status_changed). Cada responsabilidade fica em seu arquivo marketingAtendimento.*.js.
 */
const { registerReadModel } = require('./readModel.registry');
const { readReconferenceDays } = require('./marketingAtendimento.settings');
const campaigns = require('./marketingAtendimento.campaigns');
const delivery = require('./marketingAtendimento.delivery');
const frequency = require('./marketingAtendimento.frequency');
const automation = require('./marketingAtendimento.automation');
const { reviews, satisfaction } = require('./marketingAtendimento.reviews');
const { complaints, sla } = require('./marketingAtendimento.support');

const MODELS = Object.freeze([campaigns, delivery, frequency, reviews, automation, satisfaction, complaints, sla]);

function register(m) {
  return registerReadModel({
    name: m.name,
    version: 1,
    keyColumns: m.keyColumns,
    eventTypes: [...m.eventTypes],
    aggregateKey: m.aggregateKey,
    recompute: m.recompute,
    scheduled: { keys: async (args) => m.scheduledKeys({ ...args, windowDays: await readReconferenceDays(args, args.transaction) }) },
    rebuild: { keys: (args) => m.rebuildKeys(args) },
  });
}

const defs = MODELS.map(register);
require('./marketingKpi.campaignMonth'); // M9-D670: custo, leads e atribuição por campanha e mês
require('./marketingKpi.optoutMonth'); // M9-D671: contatos alcançados e pedidos de saída por mês e canal

module.exports = { defs, MODELS };
