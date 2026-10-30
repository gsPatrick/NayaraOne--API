'use strict';

const AppError = require('../../../utils/AppError');
const { assertContractReportForRelease } = require('../contract/contract.report');
const { assertReportCoversApiVersion } = require('../contract/contract.version');
const { readContractParams } = require('../contract/contract.params');
const { registerReadinessCheck } = require('../health/productionReadiness');

/**
 * Evidências 1 e 2 do portão (M9-D256 3.1): relatório de contract tests (M9-D222) em modo LIVE (homologação do fornecedor) e em SANDBOX determinístico, ambos verdes,
 * recentes (`integration.contract.report_validity_days`), do adapter atual e da versão de API da connection. Devolve null quando confere ou { code, message }.
 */
async function contractProblem(providerCode, { live, apiVersion = null }, ctx, transaction) {
  const { reportValidityDays } = await readContractParams(ctx, transaction);
  try {
    const report = assertContractReportForRelease(providerCode, { maxAgeDays: reportValidityDays, requireLive: live });
    assertReportCoversApiVersion(report, apiVersion);
    return null;
  } catch (err) {
    return { code: err.code || 'INTEGRATION_CONTRACT_REPORT_MISSING', message: err.message };
  }
}

/** Item "contractTests" do assessProductionReadiness (M9-D223): a suíte em sandbox verde para o fornecedor. */
registerReadinessCheck('contractTests', async (providerCode, ctx, transaction) => {
  const p = await contractProblem(providerCode, { live: false }, ctx, transaction);
  return p ? { ok: false, detail: p.message } : { ok: true, detail: 'relatório de contract tests (sandbox) verde, recente e do adapter atual' };
});

/**
 * Ativar em PRODUÇÃO exige a suíte verde do adapter (M9-D222): adapter coberto por contract tests sem relatório verde, recente e do código atual não fica ACTIVE em
 * produção, mesmo já liberado (o adapter pode ter mudado depois da liberação). Lança 409 INTEGRATION_CONTRACT_REPORT_*. Fornecedor sem suíte (fora da lista de alvos) não é barrado aqui.
 */
async function assertSuiteGreenForActivation(connection, ctx, transaction) {
  const { listTargets } = require('../contract/contract.targets');
  if (!listTargets().some((a) => a.providerCode === connection.providerCode)) return;
  const problema = await contractProblem(connection.providerCode, { live: false, apiVersion: connection.apiVersion }, ctx, transaction);
  if (problema) throw AppError.conflict(problema.message, problema.code);
}

module.exports = { contractProblem, assertSuiteGreenForActivation };
