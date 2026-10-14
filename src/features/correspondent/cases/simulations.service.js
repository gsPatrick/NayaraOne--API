'use strict';

const { FinancingCase, Simulation } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { resolveFinancingProviderAdapterByCode } = require('../adapters/resolveFinancingProviderAdapter');

/**
 * createSimulation — Marco 8 Fase 3. Chama `adapter.simulate()` do provider configurado no
 * próprio case e persiste o resultado como uma NOVA linha — nunca sobrescreve uma simulação
 * anterior ("múltiplas simulações ficam versionadas", Caderno Técnico). O adapter nunca é
 * chamado com o case inteiro: só os campos relevantes pro cálculo (amount/termMonths), pra não
 * vazar dado de proponente/documento pra um "provider" que, na prática hoje, é só sandbox/manual.
 */
async function createSimulation(financingCaseId, payload, actorUserId, groupId, companyId, transaction) {
  const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction });
  if (!financingCase) {
    throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  }

  const amount = Number(payload?.amount);
  const termMonths = Number(payload?.termMonths);
  if (!amount || amount <= 0) {
    throw AppError.badRequest('Informe o valor financiado ("amount"), maior que zero.', 'SIMULATION_VALIDATION');
  }
  if (!termMonths || termMonths <= 0 || !Number.isInteger(termMonths)) {
    throw AppError.badRequest('Informe o prazo em meses ("termMonths"), um número inteiro maior que zero.', 'SIMULATION_VALIDATION');
  }

  const adapter = resolveFinancingProviderAdapterByCode(financingCase.providerCode);
  if (!adapter) {
    throw AppError.internal(`Provider "${financingCase.providerCode}" configurado no caso não é suportado.`, 'SIMULATION_PROVIDER_UNKNOWN');
  }
  if (!adapter.capabilities().simulate) {
    throw AppError.badRequest(
      'O provider configurado para este caso não realiza simulação automática — a proposta precisa ser levantada diretamente com o banco.',
      'SIMULATION_NOT_SUPPORTED'
    );
  }

  const requestSnapshot = { amount, termMonths };
  const result = await adapter.simulate(requestSnapshot);

  const simulation = await Simulation.create(
    {
      groupId,
      companyId,
      financingCaseId,
      providerCode: financingCase.providerCode,
      amount,
      termMonths,
      monthlyPayment: result.monthlyPayment,
      rate: result.rate,
      requestSnapshot,
      responseSnapshot: result,
      createdBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.simulation.created',
      entityType: 'FinancingCase',
      entityId: financingCaseId,
      reason: `Simulação criada (provider "${financingCase.providerCode}", valor R$ ${amount.toFixed(2)}, ${termMonths} meses, parcela R$ ${Number(result.monthlyPayment).toFixed(2)}).`,
    },
    transaction
  );

  return simulation;
}

async function listSimulations(financingCaseId, groupId, companyId, transaction) {
  const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction });
  if (!financingCase) {
    throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  }
  return Simulation.findAll({
    where: { financingCaseId, groupId, companyId },
    order: [['created_at', 'DESC']],
    transaction,
  });
}

module.exports = { createSimulation, listSimulations };
