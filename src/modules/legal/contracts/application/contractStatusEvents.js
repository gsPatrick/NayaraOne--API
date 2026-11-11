'use strict';

const { ContractVersion } = require('../../../../models');
const { publishContractRenewalChange } = require('../../cases/legalDeadlineCalendarEvents.service');
const { publishContractStatusChanged, publishContractActivated, publishContractTerminated, publishCadernoEvent } = require('../../shared/legalEvents.service');

/**
 * Eventos de uma mudança de status do contrato (Caderno M5 §18, Guia §15), num lugar só para que TODO caminho que muda o
 * status publique o mesmo conjunto (DI-M5CT-1): a transição genérica (/transition, webhook de assinatura, versão nova em
 * SIGNING) e as dedicadas (suspender, reativar, encerrar, arquivar).
 *
 *   status de destino   evento do livro
 *   APPROVED            contract.version.approved — só quando uma versão foi DE FATO aprovada nesta transição
 *                       (approvedVersion com status APPROVED); voltar de SIGNING para APPROVED não aprova nada.
 *   SIGNING             contract.sent_for_signature
 *   SIGNED              contract.signed
 *   ACTIVE              contract.activated (ativação SIGNED -> ACTIVE e reativação SUSPENDED -> ACTIVE)
 *   TERMINATED          contract.terminated (pelo /terminate e pelo /transition)
 * Sempre: legal.contract.status_changed e o ajuste da renovação no calendário.
 */
const latestVersion = (contractId, transaction) => ContractVersion.findOne({ where: { contractId }, order: [['version_number', 'DESC']], transaction });

/** contract.version.approved com a versão aprovada e o hash dela; uma vez por versão (a chave leva o id da versão). */
function publishVersionApproved(contract, version, fromStatus, transaction) {
  if (!version || version.status !== 'APPROVED') return null;
  return publishCadernoEvent(
    'contract.version.approved',
    'Contract',
    contract,
    { id: contract.id, fromStatus, contractVersionId: version.id, contentHash: version.contentHash },
    `version:${version.id}`,
    transaction
  );
}

async function publishVersionEvent(eventType, contract, fromStatus, transaction) {
  const current = await latestVersion(contract.id, transaction);
  return publishCadernoEvent(
    eventType,
    'Contract',
    contract,
    { id: contract.id, fromStatus, contractVersionId: current ? current.id : null, contentHash: current ? current.contentHash : null },
    contract.lockVersion,
    transaction
  );
}

async function publishStatusEvents(contract, fromStatus, { approvedVersion = null } = {}, transaction) {
  await publishContractStatusChanged(contract, fromStatus, transaction);
  await publishContractRenewalChange(contract, transaction);
  switch (contract.status) {
    case 'APPROVED':
      await publishVersionApproved(contract, approvedVersion, fromStatus, transaction);
      break;
    case 'SIGNING':
      await publishVersionEvent('contract.sent_for_signature', contract, fromStatus, transaction);
      break;
    case 'SIGNED':
      await publishVersionEvent('contract.signed', contract, fromStatus, transaction);
      break;
    case 'ACTIVE':
      await publishContractActivated(contract, transaction);
      break;
    case 'TERMINATED':
      await publishContractTerminated(contract, transaction);
      break;
    default:
      break;
  }
}

module.exports = { publishStatusEvents, publishVersionApproved };
