'use strict';

const { sequelize, Group, Company } = require('../../models');
const { safeLogger } = require('../../features/ai/audit');
const { detectForgottenLeadsForCompany, readForgottenParams } = require('../../features/ai/agents/nay_comercial');

/**
 * nayComercialForgottenLeadsJob (livro do Marco 3 §16 "Detecta lead esquecido", rodada M3CB): a cada
 * `ia.comercial.lead_esquecido.intervalo_horas` (padrão 24 h, por empresa) a NAY Comercial procura as oportunidades abertas sem contato há
 * mais de `ia.comercial.lead_esquecido.dias_sem_contato` dias e cria UMA recomendação LEAD_ESQUECIDO para o responsável de cada uma
 * (idempotente). Só age na empresa com a detecção ligada (`ia.comercial.lead_esquecido.ativo`), a NAY ligada e a NAY Comercial ativa.
 * O relógio acorda de TICK_MS em TICK_MS; quem decide se a empresa está na hora é o parâmetro dela. Falha de uma empresa não derruba as
 * demais. Roda sobre o nayara_runtime (RLS FORCE por empresa).
 */
const TICK_MS = 5 * 60 * 1000;
const lastRun = new Map();

async function tenantTx(group, company, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return fn(transaction);
  });
}

async function runCompany(group, company, now) {
  const ctx = { groupId: group.id, companyId: company.id };
  const due = await tenantTx(group, company, async (transaction) => {
    const { intervalHours } = await readForgottenParams(ctx, transaction);
    const last = lastRun.get(company.id);
    return !last || now.getTime() - last >= intervalHours * 3600 * 1000;
  });
  if (!due) return null;
  lastRun.set(company.id, now.getTime());
  return tenantTx(group, company, (transaction) => detectForgottenLeadsForCompany(ctx, transaction, { now }));
}

/** Uma passada por todas as empresas. `force` ignora o intervalo (teste e execução manual). */
async function runNayComercialForgottenLeadsJob({ now = new Date(), force = false } = {}) {
  if (force) lastRun.clear();
  const groups = await Group.findAll();
  const summary = { companies: 0, detected: 0, created: 0, skipped: 0, errors: 0 };
  for (const group of groups) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      try {
        const r = await runCompany(group, company, now);
        if (r && r.ready) {
          summary.companies += 1;
          summary.detected += r.detected;
          summary.created += r.created;
          summary.skipped += r.skipped;
        }
      } catch (err) {
        summary.errors += 1;
        safeLogger.error({ err, companyId: company.id }, '[NayComercialForgottenLeadsJob] falha na empresa');
      }
    }
  }
  if (summary.created) safeLogger.info(summary, '[NayComercialForgottenLeadsJob] leads esquecidos recomendados');
  return summary;
}

function startNayComercialForgottenLeadsJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runNayComercialForgottenLeadsJob().finally(() => { running = false; }).catch((err) => {
      safeLogger.error({ err }, '[NayComercialForgottenLeadsJob] falha na execução agendada');
    });
  }, tickMs);
}

module.exports = { runNayComercialForgottenLeadsJob, startNayComercialForgottenLeadsJob };
