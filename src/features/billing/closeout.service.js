'use strict';

const { Contract } = require('../../models');
const { collectContractClosurePendencies } = require('../legal/contractClosureGate');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishCloseoutBlocked, publishCloseoutCompleted } = require('./billingEvents.service');
const contractsService = require('../legal/contracts.service');

/**
 * checkCloseoutEligibility — Frente 5: delega ao GATE ÚNICO de encerramento
 * (legal/contractClosureGate.js). Antes este arquivo tinha sua própria lista (só cobrança e
 * utilidades) e o jurídico outra (só garantia e processo) — agora é uma lista só para todos os
 * caminhos: cobrança, caso de cobrança, utilidades, garantia, saldo de caução, processos, prazos
 * e notificações. Retorna a lista de pendências (vazia = pode encerrar).
 */
async function checkCloseoutEligibility(contractId, transaction) {
  // JUR-015 (fail closed): contrato inexistente ou de outra empresa (invisível pela RLS) nunca
  // é declarado "elegível" — antes a consulta devolvia eligible:true com zero pendências.
  const contract = await Contract.findByPk(contractId, { transaction });
  if (!contract) throw AppError.notFound('Contrato não encontrado.', 'CLOSEOUT_CONTRACT_NOT_FOUND');
  return collectContractClosurePendencies(contractId, transaction);
}

/**
 * closeoutContract — tenta encerrar (closeout) um contrato de locação. Se houver QUALQUER
 * pendência crítica retornada por `checkCloseoutEligibility`, bloqueia (409) e publica
 * `closeout.blocked` com os motivos. Se não houver pendência, libera e publica
 * `closeout.completed`. Nunca libera "por omissão" — fail-closed também aqui: qualquer
 * pendência encontrada bloqueia.
 */
async function closeoutContract(contractId, actorUserId, transaction) {
  const contract = await Contract.findByPk(contractId, { transaction });
  if (!contract) throw AppError.notFound('Contrato não encontrado.', 'CLOSEOUT_CONTRACT_NOT_FOUND');

  const reasons = await checkCloseoutEligibility(contractId, transaction);

  if (reasons.length > 0) {
    await publishCloseoutBlocked(contract, reasons, transaction);
    await registrarAuditoria(
      {
        groupId: contract.groupId,
        companyId: contract.companyId,
        actorUserId,
        action: 'billing.closeout.blocked',
        entityType: 'Contract',
        entityId: contract.id,
        afterJson: { reasons },
        reason: `Closeout do contrato ${contract.id} bloqueado por ${reasons.length} pendência(s) crítica(s).`,
      },
      transaction
    );
    throw AppError.conflict(
      `Não é possível encerrar a locação: há pendências críticas (${reasons.map((r) => r.type).join(', ')}).`,
      'CLOSEOUT_BLOCKED',
      { reasons }
    );
  }

  await publishCloseoutCompleted(contract, transaction);
  await registrarAuditoria(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      actorUserId,
      action: 'billing.closeout.completed',
      entityType: 'Contract',
      entityId: contract.id,
      reason: `Closeout do contrato ${contract.id} concluído sem pendências críticas.`,
    },
    transaction
  );

  // FIX DIVERGÊNCIA (auditoria técnica da cliente, 07/10/2026): closeout financeiro concluído
  // (sem pendência crítica) NÃO fazia o Contract avançar na máquina de estados jurídica — o
  // encerramento financeiro (Billing) e o encerramento jurídico (Contract.status) viviam
  // desconectados, apesar de serem o MESMO evento de negócio ("a locação terminou"). Agora que
  // SUSPENDED/TERMINATED/CLOSED existem de fato na máquina de estados (contracts.service.js),
  // o closeout sem pendências avança o contrato ATÉ CLOSED (passando por TERMINATED quando
  // aplicável), reusando os MESMOS gates de terminateContract/closeContract (ex.: garantia ACTIVE
  // pendente, processo jurídico aberto) — fail closed também aqui: se esses gates bloquearem, o
  // closeout financeiro já foi registrado como COMPLETED (não há pendência financeira), mas o
  // arquivamento jurídico fica pendente e é reportado separadamente, sem reverter o que já foi
  // liberado no Financeiro.
  //
  // Contratos que nunca chegaram a ACTIVE/SUSPENDED (ex.: DRAFT em testes antigos que só testam
  // a parte financeira do closeout) simplesmente não têm transição de TERMINATED disponível a
  // partir do seu status atual — VALID_TRANSITIONS não inclui a saída, então nenhuma tentativa é
  // feita (comportamento idêntico ao anterior, sem quebrar nada).
  let contractLifecycle = null;
  if (contractsService.VALID_TRANSITIONS[contract.status]?.includes('TERMINATED')) {
    try {
      const terminated = await contractsService.terminateContract(
        contract.id,
        'Closeout financeiro concluído sem pendências críticas — encerramento automático.',
        actorUserId,
        transaction
      );
      const closed = await contractsService.closeContract(
        terminated.id,
        'Closeout financeiro concluído — arquivamento operacional automático.',
        actorUserId,
        transaction
      );
      contractLifecycle = closed.status;
    } catch (err) {
      // Não reverte o closeout financeiro (já legitimamente concluído) — só reporta que o
      // encerramento jurídico do Contract ficou pendente de ação manual (ex.: garantia ACTIVE
      // ainda não liberada, processo jurídico aberto).
      contractLifecycle = { blocked: true, code: err.code, message: err.message };
    }
  }

  return { contractId: contract.id, status: 'COMPLETED', contractLifecycle };
}

module.exports = { checkCloseoutEligibility, closeoutContract };
