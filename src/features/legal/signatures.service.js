'use strict';

const { Signature, ContractVersion } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishSignatureRequested, publishSignatureSigned } = require('./legalEvents.service');
const { getContractVersion } = require('./contractVersions.service');
const { getContract, transitionContractStatus } = require('./contracts.service');
const { SandboxSignatureAdapter, ClicksignSignatureAdapter, ZapSignSignatureAdapter } = require('./adapters/SignatureAdapter');
const { getSetting, getDecryptedSetting } = require('../settings/settings.service');

/**
 * resolveSignatureAdapter — resolve o adapter de assinatura em runtime, por tenant, a partir
 * de `legal.signature_provider` (settings). O token do provedor escolhido é descriptografado
 * SÓ dentro desta função (escopo da chamada que monta o adapter) — nunca é guardado
 * descriptografado em memória além da instância do adapter recém-criada, que vive apenas
 * durante esta requisição.
 *
 * Fallback seguro: se o provider configurado for "sandbox", OU se não houver token
 * configurado para o provider escolhido (ex.: cliente selecionou "clicksign" no painel mas
 * ainda não preencheu o token), caímos para `SandboxSignatureAdapter` — a ausência de
 * configuração NUNCA quebra o fluxo de negócio de solicitar assinatura.
 */
async function resolveSignatureAdapter(tenant, transaction) {
  const provider = await getSetting('legal.signature_provider', tenant, transaction, 'sandbox');

  if (provider === 'clicksign') {
    const apiToken = await getDecryptedSetting('legal.clicksign_api_token', tenant, transaction, null);
    if (apiToken) return new ClicksignSignatureAdapter({ apiToken });
  } else if (provider === 'zapsign') {
    const apiToken = await getDecryptedSetting('legal.zapsign_api_token', tenant, transaction, null);
    if (apiToken) return new ZapSignSignatureAdapter({ apiToken });
  }

  // Fallback seguro: sandbox por padrão, ou quando o provider real não tem token configurado.
  return new SandboxSignatureAdapter();
}

async function initiateSignature(contractVersionId, signerPersonIds, actorUserId, transaction) {
  if (!Array.isArray(signerPersonIds) || signerPersonIds.length === 0) {
    throw AppError.badRequest('"signerPersonIds" deve ser uma lista não vazia de person ids.', 'LEGAL_SIGNATURE_VALIDATION');
  }
  const contractVersion = await getContractVersion(contractVersionId, transaction);

  const signatureAdapter = await resolveSignatureAdapter(
    { groupId: contractVersion.groupId, companyId: contractVersion.companyId },
    transaction
  );
  const { externalSignatureIdsByPerson } = await signatureAdapter.requestSignature(contractVersion, signerPersonIds);

  const signatures = [];
  for (const personId of signerPersonIds) {
    const signature = await Signature.create(
      {
        groupId: contractVersion.groupId,
        companyId: contractVersion.companyId,
        contractVersionId: contractVersion.id,
        personId,
        status: 'PENDING',
        externalSignatureId: externalSignatureIdsByPerson[personId],
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );

    await publishSignatureRequested(signature, transaction);

    await registrarAuditoria(
      {
        groupId: contractVersion.groupId,
        companyId: contractVersion.companyId,
        actorUserId,
        action: 'legal.signature.request',
        entityType: 'Signature',
        entityId: signature.id,
        afterJson: signature.toJSON(),
        reason: `Assinatura solicitada (provider: ${signatureAdapter.constructor.name}) à pessoa ${personId} para a versão ${contractVersion.id} do contrato.`,
      },
      transaction
    );

    signatures.push(signature);
  }

  return signatures;
}

async function listSignaturesByContractVersion(contractVersionId, transaction) {
  return Signature.findAll({ where: { contractVersionId }, transaction });
}

/**
 * handleSignatureWebhook — idempotente: se a Signature já estiver SIGNED, não reaplica
 * efeitos (não republica evento, não tenta re-transicionar o contrato). Quando TODAS as
 * signatures da mesma contract_version estiverem SIGNED, dispara a transição do Contract
 * pai para SIGNED via transitionContractStatus.
 */
async function handleSignatureWebhook(externalSignatureId, payload, transaction) {
  const signature = await Signature.findOne({ where: { externalSignatureId }, transaction });
  if (!signature) {
    throw AppError.notFound('Assinatura não encontrada para o externalSignatureId informado.', 'LEGAL_SIGNATURE_NOT_FOUND');
  }

  // Idempotência: webhook duplicado do provedor não deve reaplicar efeito nem falhar.
  if (signature.status === 'SIGNED') {
    return { signature, contractTransitioned: false, alreadyProcessed: true };
  }

  const beforeJson = signature.toJSON();
  signature.status = 'SIGNED';
  signature.signedAt = (payload && payload.signedAt) || new Date();
  signature.updatedBy = null; // webhook é evento de sistema, sem actor humano
  await signature.save({ transaction });

  await publishSignatureSigned(signature, transaction);

  await registrarAuditoria(
    {
      groupId: signature.groupId,
      companyId: signature.companyId,
      actorUserId: null,
      action: 'legal.signature.signed',
      entityType: 'Signature',
      entityId: signature.id,
      beforeJson,
      afterJson: signature.toJSON(),
      reason: `Assinatura confirmada via webhook do provedor (externalSignatureId=${externalSignatureId}).`,
    },
    transaction
  );

  const allSignatures = await Signature.findAll({ where: { contractVersionId: signature.contractVersionId }, transaction });
  const allSigned = allSignatures.length > 0 && allSignatures.every((s) => s.status === 'SIGNED');

  let contractTransitioned = false;
  if (allSigned) {
    const contractVersion = await ContractVersion.findByPk(signature.contractVersionId, { transaction });
    const contract = await getContract(contractVersion.contractId, transaction);
    // Só tenta transicionar se o contrato ainda não estiver em SIGNED/ACTIVE — evita erro de
    // transição inválida se o webhook do último signatário chegar duplicado numa corrida rara.
    if (contract.status === 'SIGNING') {
      await transitionContractStatus(contract, 'SIGNED', null, transaction);
      contractTransitioned = true;
    }
  }

  return { signature, contractTransitioned, alreadyProcessed: false };
}

module.exports = { initiateSignature, listSignaturesByContractVersion, handleSignatureWebhook, resolveSignatureAdapter };
