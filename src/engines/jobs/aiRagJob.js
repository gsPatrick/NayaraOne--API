'use strict';

const { sequelize, Group, Company } = require('../../models');
const { processPending, reconcileChunks, readRagParams } = require('../../features/ai/retrieval');
const { safeLogger } = require('../../features/ai/audit');

/**
 * aiRagJob (Marco 9, M9-D022 e M9-D023): a cada passada (1 min) leva à frente as ingestões PENDING do conhecimento homologado (a ingestão
 * é automática: a homologação só cria a linha) e, a cada `ia.rag.reconciliar_minutos` (padrão 5, por empresa), reconcilia permissão e
 * classificação dos chunks com a origem. Falha de uma empresa não derruba as demais. Roda sobre o nayara_runtime (RLS FORCE por empresa).
 */
const TICK_MS = 60 * 1000;
const lastReconcile = new Map();

async function tenantTx(group, company, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return fn(transaction);
  });
}

async function runCompany(group, company, now) {
  const ctx = { groupId: group.id, companyId: company.id };
  const ingested = await tenantTx(group, company, (transaction) => processPending(ctx, transaction));
  const due = await tenantTx(group, company, async (transaction) => {
    const { reconcileMinutes } = await readRagParams(ctx, transaction);
    const last = lastReconcile.get(company.id);
    return !last || now.getTime() - last >= reconcileMinutes * 60 * 1000;
  });
  let reconciled = null;
  if (due) {
    lastReconcile.set(company.id, now.getTime());
    reconciled = await tenantTx(group, company, (transaction) => reconcileChunks(ctx, transaction));
  }
  return { ingested: ingested.length, reconciled };
}

/** Uma passada por todas as empresas (ou só as de `companyIds`). `force` ignora o intervalo da reconciliação (teste e execução manual). */
async function runAiRagJob({ now = new Date(), force = false, companyIds } = {}) {
  if (force) lastReconcile.clear();
  const groups = await Group.findAll();
  const summary = { companies: 0, ingested: 0, updated: 0, retracted: 0, errors: 0 };
  for (const group of groups) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies.filter((c) => !companyIds || companyIds.includes(c.id))) {
      try {
        const r = await runCompany(group, company, now);
        summary.companies += 1;
        summary.ingested += r.ingested;
        if (r.reconciled) { summary.updated += r.reconciled.updated; summary.retracted += r.reconciled.retracted; }
      } catch (err) {
        summary.errors += 1;
        safeLogger.error({ err, companyId: company.id }, '[AiRagJob] falha na empresa');
      }
    }
  }
  if (summary.ingested || summary.updated || summary.retracted) safeLogger.info(summary, '[AiRagJob] ingestões e reconciliação do RAG');
  return summary;
}

function startAiRagJob({ tickMs = TICK_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runAiRagJob().finally(() => { running = false; }).catch((err) => {
      safeLogger.error({ err }, '[AiRagJob] falha na execução agendada');
    });
  }, tickMs);
}

module.exports = { runAiRagJob, startAiRagJob };
