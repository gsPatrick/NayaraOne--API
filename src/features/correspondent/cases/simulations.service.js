'use strict';

const { sequelize, FinancingCase, Simulation } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { resolveFinancingProviderAdapterByCode } = require('../adapters/resolveFinancingProviderAdapter');
const { assertEligible } = require('../eligibility.service');
const { assertCaseAcceptsAction } = require('./caseActionGate');
const { recordIntegrationError } = require('../integrationErrors.service');
const { publishIntegrationCorrespondentFailed } = require('../correspondentEvents.service');
const { sanitizeProviderMessage } = require('../sanitizeProviderMessage');

const MAX_AMOUNT = 99999999999;
const MAX_TERM_MONTHS = 480;

// Prazo de espera do provider: variável de ambiente só vale se for um número válido.
function providerTimeoutMs() {
  const value = Number(process.env.CORRESPONDENT_SUBMIT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 8000;
}

/**
 * recordSimulationFailure — falha do provider na simulação vira erro de integração visível e evento.
 * Como a requisição volta (rollback) ao devolver o erro, o registro vai numa transação própria; nos
 * testes (transação que nunca confirma) vai dentro de um ponto de salvamento.
 */
async function recordSimulationFailure(financingCase, message, transaction) {
  const write = async (tx) => {
    await recordIntegrationError({ groupId: financingCase.groupId, companyId: financingCase.companyId, financingCaseId: financingCase.id, providerCode: financingCase.providerCode, operation: 'simulate', errorCode: 'SIMULATION_FAILED', message }, tx);
    await publishIntegrationCorrespondentFailed(financingCase, { providerCode: financingCase.providerCode, reason: message, submissionId: `simulate:${financingCase.id}:${Date.now()}` }, tx);
  };
  try {
    if (process.env.NODE_ENV === 'test') {
      await sequelize.transaction({ transaction }, write);
    } else {
      await sequelize.transaction(async (tx) => {
        await sequelize.query("SELECT set_config('app.group_id', :groupId, true), set_config('app.company_id', :companyId, true)", { replacements: { groupId: financingCase.groupId, companyId: financingCase.companyId }, transaction: tx });
        await write(tx);
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[Simulations] Não foi possível registrar a falha da simulação: ${sanitizeProviderMessage(err.message)}`);
  }
}

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
  await assertCaseAcceptsAction(financingCase, 'simulation', transaction);

  const rawAmount = Number(payload?.amount);
  const termMonths = Number(payload?.termMonths);
  if (!Number.isFinite(rawAmount) || rawAmount <= 0 || rawAmount > MAX_AMOUNT) {
    throw AppError.badRequest('Informe o valor financiado, maior que zero e menor que R$ 100 bilhões.', 'SIMULATION_VALIDATION');
  }
  // O banco guarda centavos: o valor usado na elegibilidade e no provider é o mesmo que será gravado.
  const amount = Math.round(rawAmount * 100) / 100;
  if (!Number.isInteger(termMonths) || termMonths <= 0 || termMonths > MAX_TERM_MONTHS) {
    throw AppError.badRequest(`Informe o prazo em meses, um número inteiro entre 1 e ${MAX_TERM_MONTHS}.`, 'SIMULATION_VALIDATION');
  }

  // Caderno: "Antes de simular/submeter, chamar Motor de Regras COR_PROVIDER_ELIGIBILITY [...].
  // Se não elegível, bloquear." — nunca chama o adapter de um case inelegível.
  await assertEligible(financingCase, { amount }, groupId, companyId, actorUserId, transaction);

  const adapter = resolveFinancingProviderAdapterByCode(financingCase.providerCode);
  if (!adapter) {
    throw AppError.unprocessable('O provider deste caso não está disponível neste ambiente. Ajuste o provider padrão da empresa e crie o caso de novo.', 'SIMULATION_PROVIDER_UNKNOWN');
  }
  const requestSnapshot = { amount, termMonths };
  let result;
  if (!adapter.capabilities().simulate) {
    if (financingCase.providerCode !== 'manual') {
      throw AppError.badRequest(
        'O provider configurado para este caso não realiza simulação automática — a proposta precisa ser levantada diretamente com o banco.',
        'SIMULATION_NOT_SUPPORTED'
      );
    }
    // Provider manual (sem API): a pessoa registra o que o banco informou, no mesmo modelo de simulação.
    const monthlyPayment = Number(payload?.monthlyPayment);
    if (!Number.isFinite(monthlyPayment) || monthlyPayment <= 0) {
      throw AppError.badRequest('Informe a parcela que o banco simulou (maior que zero): este provider não simula sozinho.', 'SIMULATION_VALIDATION');
    }
    if (monthlyPayment > MAX_AMOUNT) {
      throw AppError.badRequest('A parcela informada é maior que o permitido.', 'SIMULATION_VALIDATION');
    }
    // Taxa não informada fica sem valor (nunca vira 0%).
    const rateInformed = !(payload?.monthlyRatePct === undefined || payload?.monthlyRatePct === null || payload?.monthlyRatePct === '');
    const monthlyRatePct = rateInformed ? Number(payload.monthlyRatePct) : null;
    if (rateInformed && (!Number.isFinite(monthlyRatePct) || monthlyRatePct < 0 || monthlyRatePct > 100)) {
      throw AppError.badRequest('A taxa mensal informada precisa estar entre 0% e 100%.', 'SIMULATION_VALIDATION');
    }
    result = { monthlyPayment: Math.round(monthlyPayment * 100) / 100, rate: rateInformed ? Math.round((monthlyRatePct / 100) * 1e6) / 1e6 : null, manual: true };
    requestSnapshot.manual = true;
  } else {
    // Sem resposta do provider no prazo a simulação falha com mensagem de negócio. Nenhuma trava de linha
    // fica segurada durante a chamada (o caso é lido sem FOR UPDATE).
    let timer;
    try {
      result = await Promise.race([
        adapter.simulate(requestSnapshot),
        new Promise((_, reject) => { timer = setTimeout(() => reject(AppError.unprocessable('O provider não respondeu a tempo. Tente simular de novo em instantes.', 'SIMULATION_PROVIDER_TIMEOUT')), providerTimeoutMs()); }),
      ]);
    } catch (err) {
      await recordSimulationFailure(financingCase, err instanceof AppError ? err.message : 'O provider não conseguiu simular. Tente de novo em instantes.', transaction);
      if (err instanceof AppError) throw err;
      throw AppError.unprocessable('O provider não conseguiu simular. Tente de novo em instantes.', 'SIMULATION_PROVIDER_FAILED');
    } finally {
      clearTimeout(timer);
    }
    // A resposta do provider é conferida antes de gravar: parcela e taxa precisam ser números válidos.
    const paymentOk = Number.isFinite(Number(result?.monthlyPayment)) && Number(result.monthlyPayment) > 0 && Number(result.monthlyPayment) <= MAX_AMOUNT;
    const rateOk = result?.rate === null || result?.rate === undefined || (Number.isFinite(Number(result.rate)) && Number(result.rate) >= 0 && Number(result.rate) < 1000);
    if (!paymentOk || !rateOk) {
      await recordSimulationFailure(financingCase, 'O provider devolveu uma simulação inválida (parcela ou taxa fora do esperado).', transaction);
      throw AppError.unprocessable('O provider devolveu uma simulação inválida. Tente de novo ou fale com o suporte.', 'SIMULATION_PROVIDER_INVALID_RESPONSE');
    }
  }

  const simulation = await Simulation.create(
    {
      groupId,
      companyId,
      financingCaseId,
      providerCode: financingCase.providerCode,
      amount,
      termMonths,
      monthlyPayment: result.monthlyPayment,
      rate: result.rate === undefined || result.rate === null ? null : Number(result.rate),
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
      reason: `Simulação criada (provider "${financingCase.providerCode}", valor R$ ${amount.toFixed(2)}, ${termMonths} meses, parcela R$ ${Number(result.monthlyPayment).toFixed(2)}${result.rate === null || result.rate === undefined ? ', taxa não informada' : ''}).`,
    },
    transaction
  );

  return simulation;
}

async function listSimulations(financingCaseId, groupId, companyId, transaction, { limit } = {}) {
  const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction });
  if (!financingCase) {
    throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  }
  return Simulation.findAll({
    where: { financingCaseId, groupId, companyId },
    order: [['created_at', 'DESC']],
    limit: Math.min(Math.max(Number(limit) || 200, 1), 500),
    transaction,
  });
}

module.exports = { createSimulation, listSimulations };
