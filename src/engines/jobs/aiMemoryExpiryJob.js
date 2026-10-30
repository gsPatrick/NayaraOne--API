'use strict';

const { sequelize, Group, Company } = require('../../models');
const { MemoryService, readMemoryParams } = require('../../features/ai/memory');
const { safeLogger } = require('../../features/ai/audit');

/**
 * aiMemoryExpiryJob (Marco 9, M9-D009): a cada `ia.memoria.intervalo_expiracao_horas` (padrão 24 h, por empresa) passa para EXPIRED a
 * memória ACTIVE da NAY que venceu. Expirada não volta a valer. A leitura já ignora a vencida pelo relógio; o job só deixa o estado
 * coerente. O relógio acorda de TICK_MS em TICK_MS; quem decide se a empresa está na hora é o parâmetro dela. Falha de uma empresa não
 * derruba as demais. Roda sobre o nayara_runtime (RLS FORCE por empresa).
 */
const TICK_MS = 60 * 1000;
const lastRun = new Map();
const memory = new MemoryService();

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
    const { expiryIntervalHours } = await readMemoryParams(ctx, transaction);
    const last = lastRun.get(company.id);
    return !last || now.getTime() - last >= expiryIntervalHours * 3600 * 1000;
  });
  if (!due) return null;
  lastRun.set(company.id, now.getTime());
  return tenantTx(group, company, (transaction) => memory.expire(ctx, transaction, { now }));
}

/** Uma passada por todas as empresas. `force` ignora o intervalo (teste e execução manual). */
async function runAiMemoryExpiryJob({ now = new Date(), force = false } = {}) {
  if (force) lastRun.clear();
  const groups = await Group.findAll();
  const summary = { companies: 0, expired: 0, errors: 0 };
  for (const group of groups) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      try {
        const n = await runCompany(group, company, now);
        if (n !== null) {
          summary.companies += 1;
          summary.expired += n;
        }
      } catch (err) {
        summary.errors += 1;
        safeLogger.error({ err, companyId: company.id }, '[AiMemoryExpiryJob] falha na empresa');
      }
    }
  }
  if (summary.expired) safeLogger.info(summary, '[AiMemoryExpiryJob] memórias vencidas expiradas');
  return summary;
}

function startAiMemoryExpiryJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runAiMemoryExpiryJob().finally(() => { running = false; }).catch((err) => {
      safeLogger.error({ err }, '[AiMemoryExpiryJob] falha na execução agendada');
    });
  }, tickMs);
}

module.exports = { runAiMemoryExpiryJob, startAiMemoryExpiryJob };
