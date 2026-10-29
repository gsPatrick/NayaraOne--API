'use strict';

const { sequelize, Group, Company } = require('../../models');
const logger = require('../../utils/logger');
const { runBirthdayDrafts, runConstructionDrafts, readConstructionScanMinutes } = require('../../features/marketing/content/types');

/**
 * marketingContentTypesJob (Marco 9, M9-D409) — a cada minuto, para cada empresa: (1) a partir da hora configurada (padrão 08:00,
 * America/Sao_Paulo) cria o rascunho de aniversário de cada aniversariante do dia (BIRTHDAY_RELATIONSHIP, só rascunho; o envio
 * passa por canSend); (2) a cada `marketing.conteudo.varredura_obras_min` minutos cria o rascunho do marco público de cada obra
 * (NAYARA_CONSTRUCTION). Idempotente (chave do dia / da etapa): reiniciar o processo ou rodar em duas instâncias não duplica.
 * Sem req HTTP: percorre grupos e empresas abrindo a transação com app.group_id/app.company_id (RLS FORCE), como os demais jobs.
 */
const INTERVAL_MS = 60 * 1000;
const lastBirthdayDate = new Map();
const lastConstructionScan = new Map();

async function tenantTx(group, company, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT set_config(\'app.group_id\', :groupId, true), set_config(\'app.company_id\', :companyId, true)', {
      replacements: { groupId: group.id, companyId: company.id }, transaction,
    });
    return fn({ groupId: group.id, companyId: company.id }, transaction);
  });
}

async function runCompany(group, company, now) {
  const result = { birthdays: 0, constructions: 0 };
  const birthday = await tenantTx(group, company, async (tenant, transaction) => {
    return runBirthdayDrafts(tenant, transaction, now, { doneDate: lastBirthdayDate.get(company.id) });
  });
  if (birthday.due) lastBirthdayDate.set(company.id, birthday.date);
  result.birthdays = birthday.created || 0;

  const last = lastConstructionScan.get(company.id);
  const everyMinutes = await tenantTx(group, company, (tenant, transaction) => readConstructionScanMinutes(tenant, transaction));
  if (!last || now.getTime() - last >= everyMinutes * 60000) {
    lastConstructionScan.set(company.id, now.getTime());
    result.constructions = (await tenantTx(group, company, (tenant, transaction) => runConstructionDrafts(tenant, transaction))).created;
  }
  return result;
}

/** Uma passada por todas as empresas. `force` ignora o que já rodou hoje e o intervalo da varredura (teste e execução manual). */
async function runMarketingContentTypesJob({ now = new Date(), force = false } = {}) {
  if (force) { lastBirthdayDate.clear(); lastConstructionScan.clear(); }
  const summary = { companies: 0, birthdays: 0, constructions: 0, errors: 0 };
  for (const group of await Group.findAll()) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      summary.companies += 1;
      try {
        const r = await runCompany(group, company, now);
        summary.birthdays += r.birthdays;
        summary.constructions += r.constructions;
      } catch (err) {
        summary.errors += 1;
        logger.error({ companyId: company.id, err: err.message }, 'marketingContentTypesJob.company.failed');
      }
    }
  }
  if (summary.birthdays || summary.constructions || summary.errors) logger.info(summary, 'marketingContentTypesJob.run');
  return summary;
}

function startMarketingContentTypesJob({ intervalMs = INTERVAL_MS } = {}) {
  const tick = () => runMarketingContentTypesJob().catch((err) => logger.error({ err: err.message }, 'marketingContentTypesJob.failed'));
  tick();
  return setInterval(tick, intervalMs);
}

module.exports = { runMarketingContentTypesJob, startMarketingContentTypesJob };
