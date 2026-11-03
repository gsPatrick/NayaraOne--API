'use strict';

const { sanitizeProviderMessage } = require('../../features/correspondent/sanitizeProviderMessage');

const { Op } = require('sequelize');
const { sequelize, Group, Company, FinancingCase, ProviderSubmission, IntegrationError } = require('../../models');
const { resolveFinancingProviderAdapterByCode } = require('../../features/correspondent/adapters/resolveFinancingProviderAdapter');
const { peekEligibilityConfig } = require('../../features/correspondent/eligibility.service');
const { applyPolledStatus } = require('../../features/correspondent/webhooks.service');
const { withTimeout, finalizeAcceptedSubmission } = require('../../features/correspondent/cases/submissions.service');
const { recordIntegrationError, resolveIntegrationError } = require('../../features/correspondent/integrationErrors.service');

/**
 * correspondentStatusPollJob (Marco 8): "getCaseStatus()" do contrato do adapter. Para provider sem
 * webhook (ou com webhook perdido), consulta o status dos casos em andamento e aplica pelas mesmas
 * regras do webhook (nunca regride, histórico bruto + normalizado). É um PARÂMETRO do admin
 * (`statusPollingEnabled`, em Parâmetros do correspondente), desligado por padrão. Provider manual
 * não é consultado (não há API do outro lado).
 */
const POLLED_STATUSES = ['SUBMITTED', 'UNDER_ANALYSIS', 'PENDING_CUSTOMER', 'PENDING_PROPERTY', 'APPROVED', 'CONTRACTING'];
const QUERY_TIMEOUT_MS = Number(process.env.CORRESPONDENT_SUBMIT_TIMEOUT_MS || 8000);

async function tenantTx(group, company, fn) {
  return sequelize.transaction(async (transaction) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: company.id }, transaction });
    return fn(transaction);
  });
}

async function pollOneCase(group, company, caseId) {
  // 1) Leitura sem trava: decide se há o que consultar.
  const plan = await tenantTx(group, company, async (transaction) => {
    const financingCase = await FinancingCase.findByPk(caseId, { transaction });
    if (!financingCase || !POLLED_STATUSES.includes(financingCase.status)) return null;
    const adapter = resolveFinancingProviderAdapterByCode(financingCase.providerCode);
    if (!adapter || financingCase.providerCode === 'manual' || !adapter.capabilities().getCaseStatus) return null;
    const submission = await ProviderSubmission.findOne({
      where: { financingCaseId: financingCase.id, status: 'SUBMITTED', externalCaseId: { [Op.ne]: null } },
      order: [['created_at', 'DESC']],
      transaction,
    });
    return submission ? { providerCode: financingCase.providerCode, externalCaseId: submission.externalCaseId } : null;
  });
  if (!plan) return false;
  // 2) Chamada ao provider, fora de qualquer transação (nenhuma trava segurada enquanto se espera).
  const adapter = resolveFinancingProviderAdapterByCode(plan.providerCode);
  const result = await withTimeout(adapter.getCaseStatus(plan.externalCaseId), QUERY_TIMEOUT_MS);
  // 3) Trava curta só para aplicar (reconfere o estado do caso).
  return tenantTx(group, company, async (transaction) => {
    const financingCase = await FinancingCase.findByPk(caseId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!financingCase || !POLLED_STATUSES.includes(financingCase.status)) return false;
    const outcome = await applyPolledStatus(financingCase, adapter, result, transaction);
    // A consulta voltou a funcionar: o alerta aberto de falha de consulta deste caso se encerra sozinho.
    const abertos = await IntegrationError.findAll({ where: { financingCaseId: caseId, errorCode: 'STATUS_POLL_FAILED', status: 'OPEN' }, transaction });
    for (const item of abertos) {
      // eslint-disable-next-line no-await-in-loop
      await resolveIntegrationError(item.id, 'A consulta de status voltou a funcionar', null, group.id, company.id, transaction);
    }
    return outcome.applied === true;
  });
}

/**
 * recoverStaleUnknownSubmissions — envio incerto (UNKNOWN) parado além da espera configurada: consulta o
 * provider pela chave de idempotência; se ele já tem o caso, recupera (grava o roteamento e o status). Se não
 * tem, NÃO libera reenvio sozinho (isso continua sendo uma decisão de pessoa).
 */
async function recoverStaleUnknownSubmissions(group, company, waitMinutes) {
  const limit = new Date(Date.now() - waitMinutes * 60000);
  const ids = await tenantTx(group, company, async (transaction) => {
    const rows = await ProviderSubmission.findAll({ where: { status: 'UNKNOWN', updated_at: { [Op.lt]: limit } }, attributes: ['id'], transaction });
    return rows.map((r) => r.id);
  });
  for (const id of ids) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const plan = await tenantTx(group, company, async (transaction) => {
        const sub = await ProviderSubmission.findByPk(id, { transaction });
        const c = sub && await FinancingCase.findByPk(sub.financingCaseId, { transaction });
        if (!sub || !c || c.status === 'CANCELED') return null;
        return { providerCode: c.providerCode, key: sub.idempotencyKey, externalCaseId: sub.externalCaseId };
      });
      if (!plan) continue;
      const adapter = resolveFinancingProviderAdapterByCode(plan.providerCode);
      if (!adapter || plan.providerCode === 'manual') continue;
      let found = null;
      // eslint-disable-next-line no-await-in-loop
      if (plan.externalCaseId) found = { externalId: plan.externalCaseId, status: 'SUBMITTED' };
      else if (typeof adapter.findSubmissionByKey === 'function') {
        // eslint-disable-next-line no-await-in-loop
        const lookup = await withTimeout(adapter.findSubmissionByKey(plan.key), QUERY_TIMEOUT_MS);
        if (lookup?.found) found = { externalId: lookup.externalId, status: lookup.status || 'SUBMITTED' };
      }
      if (!found) continue;
      // eslint-disable-next-line no-await-in-loop
      await tenantTx(group, company, async (transaction) => {
        const sub = await ProviderSubmission.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!sub || sub.status !== 'UNKNOWN') return;
        const c = await FinancingCase.findByPk(sub.financingCaseId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!c) return;
        await finalizeAcceptedSubmission(adapter, sub, c, found, null, transaction, { sendDocuments: false });
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[CorrespondentStatusPollJob] Falha ao recuperar envio incerto ${id}: ${sanitizeProviderMessage(err.message)}`);
    }
  }
}

async function pollCompany(group, company) {
  const config = await tenantTx(group, company, async (transaction) => peekEligibilityConfig(group.id, company.id, transaction));
  if (config.statusPollingEnabled !== true) return { candidates: 0, applied: 0 };
  await recoverStaleUnknownSubmissions(group, company, Number.isInteger(config.unknownReleaseMinutes) ? config.unknownReleaseMinutes : 2);

  const ids = await tenantTx(group, company, async (transaction) => {
    const rows = await FinancingCase.findAll({ where: { status: { [Op.in]: POLLED_STATUSES }, providerCode: { [Op.ne]: 'manual' } }, attributes: ['id'], transaction });
    return rows.map((r) => r.id);
  });
  let applied = 0;
  for (const id of ids) {
    try {
      // eslint-disable-next-line no-await-in-loop
      if (await pollOneCase(group, company, id)) applied += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[CorrespondentStatusPollJob] Falha ao consultar o caso ${id}: ${sanitizeProviderMessage(err.message)}`);
      try {
        // eslint-disable-next-line no-await-in-loop
        await tenantTx(group, company, async (transaction) => {
          const c = await FinancingCase.findByPk(id, { transaction });
          if (!c) return;
          const jaAberto = await IntegrationError.findOne({ where: { financingCaseId: id, errorCode: 'STATUS_POLL_FAILED', status: 'OPEN' }, transaction });
          if (jaAberto) return; // um alerta aberto por caso basta (não enche a fila a cada minuto)
          await recordIntegrationError(
            { groupId: group.id, companyId: company.id, financingCaseId: id, providerCode: c.providerCode, operation: 'status', errorCode: 'STATUS_POLL_FAILED', message: 'Não foi possível consultar o status do caso no provider. A consulta será repetida.' },
            transaction
          );
        });
      } catch (ignored) {
        // registrar o erro nunca derruba a rodada
      }
    }
  }
  return { candidates: ids.length, applied };
}

async function runCorrespondentStatusPollJob() {
  const groups = await Group.findAll();
  const summary = { companiesChecked: 0, candidates: 0, applied: 0, errors: 0 };
  for (const group of groups) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      summary.companiesChecked += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await pollCompany(group, company);
        summary.candidates += r.candidates;
        summary.applied += r.applied;
      } catch (err) {
        summary.errors += 1;
        // eslint-disable-next-line no-console
        console.error(`[CorrespondentStatusPollJob] Falha na empresa ${company.id}: ${sanitizeProviderMessage(err.message)}`);
      }
    }
  }
  return summary;
}

const DEFAULT_INTERVAL_MS = Number(process.env.CORRESPONDENT_STATUS_POLL_INTERVAL_MS || 60000);

function startCorrespondentStatusPollJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  let running = false;
  return setInterval(() => {
    if (running) return; // rodada anterior ainda em andamento: não sobrepõe
    running = true;
    runCorrespondentStatusPollJob().finally(() => { running = false; }).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[CorrespondentStatusPollJob] Falha na execução agendada:', err.message);
    });
  }, intervalMs);
}

module.exports = { runCorrespondentStatusPollJob, startCorrespondentStatusPollJob, pollCompanyForTest: pollCompany };
