'use strict';

const crypto = require('crypto');
const { Signature, ContractVersion, ContractParty, Person, File, SignatureProviderRouting } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishSignatureRequested, publishSignatureSigned } = require('./legalEvents.service');
const { getContractVersion } = require('./contractVersions.service');
const { getContract, transitionContractStatus, listContractParties, REQUIRED_ROLES_BY_TYPE } = require('./contracts.service');
const { SandboxSignatureAdapter, ClicksignSignatureAdapter, ZapSignSignatureAdapter } = require('./adapters/SignatureAdapter');
const { getSetting, getDecryptedSetting } = require('../settings/settings.service');
const diskStorage = require('../../utils/diskStorage');

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
    const environment = await getSetting('legal.clicksign_environment', tenant, transaction, 'production');
    const baseUrl = environment === 'sandbox' ? 'https://sandbox.clicksign.com/api/v3' : 'https://app.clicksign.com/api/v3';
    if (apiToken) return new ClicksignSignatureAdapter({ apiToken, baseUrl });
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

  // ADV (M5-32): mandar um contrato CANCELADO para assinatura era possível — o service só
  // olhava a ContractVersion e nunca o estado do contrato pai. Resultado: signatários recebendo
  // para assinar um documento que a empresa já cancelou, e uma Signature PENDING pendurada num
  // contrato terminal. Cancelado é estado terminal: nada mais é solicitado sobre ele.
  const contract = await getContract(contractVersion.contractId, transaction);
  if (contract.status === 'CANCELLED') {
    throw AppError.conflict(
      'Não é possível solicitar assinatura de um contrato CANCELADO.',
      'LEGAL_SIGNATURE_CONTRACT_CANCELLED'
    );
  }
  // FIX (homologação 22/09/2026, achado real ao gerar evidência de teste do Clicksign): nada
  // aqui verificava que o contrato estivesse em SIGNING antes de aceitar uma solicitação de
  // assinatura — dava pra pedir assinatura de um contrato ainda em DRAFT (ou qualquer outro
  // status). Resultado: a Signature ficava SIGNED de verdade no provedor, mas o contrato nunca
  // transicionava (handleSignatureWebhook só promove pra SIGNED quando o contrato já está em
  // SIGNING), gerando um estado contraditório — "assinado em X" com o contrato ainda em
  // "Rascunho". Fail closed: só aceita solicitar assinatura com o contrato já em SIGNING.
  if (contract.status !== 'SIGNING') {
    throw AppError.conflict(
      `Não é possível solicitar assinatura: o contrato precisa estar em "SIGNING" (está em "${contract.status}").`,
      'LEGAL_SIGNATURE_CONTRACT_NOT_SIGNING'
    );
  }

  const signatureAdapter = await resolveSignatureAdapter(
    { groupId: contractVersion.groupId, companyId: contractVersion.companyId },
    transaction
  );
  const { providerEnvelopeId, externalSignatureIdsByPerson } = await signatureAdapter.requestSignature(contractVersion, signerPersonIds, transaction);

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
        providerEnvelopeId: providerEnvelopeId || null,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );

    // Grava o mapeamento de roteamento (ver migration 20260101000172) na MESMA transação/
    // tenant — é o único jeito do webhook público do provedor (sem JWT, sem tenant conhecido
    // de antemão) descobrir group_id/company_id antes de aplicar RLS. Só grava quando existe
    // externalSignatureId real (provedor real) — sandbox não recebe webhook de verdade.
    if (signature.externalSignatureId) {
      await SignatureProviderRouting.create(
        {
          externalSignatureId: signature.externalSignatureId,
          providerEnvelopeId: providerEnvelopeId || null,
          groupId: contractVersion.groupId,
          companyId: contractVersion.companyId,
        },
        { transaction }
      );
    }

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
  // Lock pessimista: duas entregas duplicadas do mesmo webhook (comum em qualquer provedor,
  // inclusive Clicksign) rodando em transações concorrentes não podem ambas passar pelo
  // findOne antes de qualquer uma commitar — sem lock, as duas veriam status !== 'SIGNED' e
  // reaplicariam o efeito (evento publicado 2x, auditoria duplicada, tentativa dupla de
  // transicionar o contrato).
  const signature = await Signature.findOne({
    where: { externalSignatureId },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
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

  // Rastreamento "quantos de quantos" (pedido explícito do usuário, 23/09/2026): a auditoria
  // antes só registrava "assinatura confirmada", sem dar visão de quantas ainda faltam — quem
  // lia o log tinha que ir contar Signatures manualmente. Busca a pessoa (nome) e o papel dela
  // no contrato (via ContractParty) pra deixar a descrição legível por humano, e conta quantas
  // das assinaturas SOLICITADAS pra esta ContractVersion já estão SIGNED (incluindo esta).
  const allSignatures = await Signature.findAll({ where: { contractVersionId: signature.contractVersionId }, transaction });
  const signedCount = allSignatures.filter((s) => s.status === 'SIGNED').length;
  const totalCount = allSignatures.length;

  const signedContractVersion = await ContractVersion.findByPk(signature.contractVersionId, { transaction });
  const [person, party] = await Promise.all([
    Person.findByPk(signature.personId, { transaction }),
    ContractParty.findOne({ where: { contractId: signedContractVersion.contractId, personId: signature.personId }, transaction }),
  ]);
  const personLabel = person ? person.legalName : signature.personId;
  const roleLabel = party ? party.partyRole : null;
  const progressLabel = signedCount >= totalCount
    ? 'todas as assinaturas concluídas'
    : `${signedCount} de ${totalCount} assinaturas concluídas`;

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
      reason: `Assinado por ${personLabel}${roleLabel ? ` (${roleLabel})` : ''} — ${progressLabel} (externalSignatureId=${externalSignatureId}).`,
    },
    transaction
  );

  const allRequestedSigned = allSignatures.length > 0 && allSignatures.every((s) => s.status === 'SIGNED');

  let contractTransitioned = false;
  if (allRequestedSigned) {
    const contractVersion = await ContractVersion.findByPk(signature.contractVersionId, { transaction });
    const contract = await getContract(contractVersion.contractId, transaction);

    // FIX (homologação 22/09/2026, M5-09 — achado real pela cliente): esta checagem só olhava
    // se TODAS as Signature JÁ SOLICITADAS estavam SIGNED, nunca se TODAS AS PARTES
    // OBRIGATÓRIAS do contrato (ex.: LANDLORD e TENANT numa locação) de fato tinham uma
    // solicitação de assinatura registrada. Resultado real: um contrato com 2 partes formais
    // virava "Assinado" tendo pedido (e recebido) assinatura de só 1 delas — a outra parte
    // nunca foi nem convidada a assinar. Agora cruza contra `REQUIRED_ROLES_BY_TYPE` (o mesmo
    // mapa já usado no gate de DRAFT->DOCUMENTS_PENDING): cada papel obrigatório do tipo de
    // contrato precisa ter PELO MENOS UMA Signature SIGNED entre as pessoas que ocupam esse
    // papel — não só "todas as que foram pedidas".
    const requiredRoles = REQUIRED_ROLES_BY_TYPE[contract.contractType] || [];
    let allPartiesSigned = true;
    if (requiredRoles.length > 0) {
      const parties = await listContractParties(contract.id, transaction);
      const signedPersonIds = new Set(allSignatures.filter((s) => s.status === 'SIGNED').map((s) => s.personId));
      allPartiesSigned = requiredRoles.every((role) =>
        parties.some((p) => p.partyRole === role && signedPersonIds.has(p.personId))
      );
    }

    // Só tenta transicionar se o contrato ainda não estiver em SIGNED/ACTIVE — evita erro de
    // transição inválida se o webhook do último signatário chegar duplicado numa corrida rara.
    if (allPartiesSigned && contract.status === 'SIGNING') {
      await transitionContractStatus(contract, 'SIGNED', null, transaction);
      contractTransitioned = true;
    }
  }

  return { signature, contractTransitioned, alreadyProcessed: false };
}

/**
 * checkSignatureStatus — consulta ATIVAMENTE o status do envelope no provedor (não espera o
 * webhook chegar) via `adapter.getStatus`. Se o provedor confirmar "assinado" e a linha local
 * ainda não refletir isso, reconcilia localmente (mesmo efeito de `handleSignatureWebhook`,
 * auditado como reconciliação manual em vez de evento de webhook).
 */
async function checkSignatureStatus(signatureId, transaction) {
  const signature = await Signature.findByPk(signatureId, { transaction });
  if (!signature) {
    throw AppError.notFound('Assinatura não encontrada.', 'LEGAL_SIGNATURE_NOT_FOUND');
  }
  if (!signature.providerEnvelopeId) {
    // Assinaturas criadas antes desta funcionalidade não têm envelope gravado — não há como
    // consultar o provedor retroativamente.
    return { signature, providerStatus: null, reconciled: false };
  }

  const adapter = await resolveSignatureAdapter(
    { groupId: signature.groupId, companyId: signature.companyId },
    transaction
  );
  const providerStatus = await adapter.getStatus(signature.providerEnvelopeId);

  const providerSaysSigned = String(providerStatus.status).toLowerCase().includes('sign')
    || String(providerStatus.status).toLowerCase().includes('closed');
  if (providerSaysSigned && signature.status !== 'SIGNED') {
    await handleSignatureWebhook(signature.externalSignatureId, {}, transaction);
    const refreshed = await Signature.findByPk(signatureId, { transaction });
    return { signature: refreshed, providerStatus, reconciled: true };
  }

  return { signature, providerStatus, reconciled: false };
}

/**
 * cancelSignature — cancela a assinatura no provedor real (se houver envelope) e marca a linha
 * local como CANCELLED. Bloqueia cancelamento de assinatura já confirmada (SIGNED) — cancelar
 * algo já assinado não desfaz o documento assinado, seria um estado inconsistente.
 */
async function cancelSignature(signatureId, actorUserId, transaction) {
  const signature = await Signature.findByPk(signatureId, { transaction });
  if (!signature) {
    throw AppError.notFound('Assinatura não encontrada.', 'LEGAL_SIGNATURE_NOT_FOUND');
  }
  if (signature.status === 'SIGNED') {
    throw AppError.conflict('Assinatura já confirmada não pode ser cancelada.', 'LEGAL_SIGNATURE_ALREADY_SIGNED');
  }
  if (signature.status === 'CANCELLED') {
    return { signature, alreadyCancelled: true };
  }

  if (signature.providerEnvelopeId) {
    const adapter = await resolveSignatureAdapter(
      { groupId: signature.groupId, companyId: signature.companyId },
      transaction
    );
    await adapter.cancel(signature.providerEnvelopeId);
  }

  const beforeJson = signature.toJSON();
  signature.status = 'CANCELLED';
  signature.updatedBy = actorUserId || null;
  await signature.save({ transaction });

  await registrarAuditoria(
    {
      groupId: signature.groupId,
      companyId: signature.companyId,
      actorUserId,
      action: 'legal.signature.cancel',
      entityType: 'Signature',
      entityId: signature.id,
      beforeJson,
      afterJson: signature.toJSON(),
      reason: 'Assinatura cancelada junto ao provedor.',
    },
    transaction
  );

  return { signature, alreadyCancelled: false };
}

/**
 * handleEnvelopeClosedWebhook — trata o evento de ENVELOPE/DOCUMENTO fechado (não confundir
 * com `handleSignatureWebhook`, que trata assinatura INDIVIDUAL de UM signatário). Disparado
 * pelos eventos `close`/`auto_close` do Clicksign (nomes reais registrados por este projeto em
 * `scripts/setupClicksignIntegration.js` — a documentação pública fala genericamente em
 * "document_closed", mas o webhook desta conta foi registrado com a lista
 * ['sign', 'refusal', 'auto_close', 'close', 'cancel', 'deadline'], então são esses os nomes
 * que efetivamente chegam aqui).
 *
 * Baixa o PDF ASSINADO de verdade do provedor (via adapter.downloadSignedDocument — ver
 * SignatureAdapter.js) e persiste em disco (uploads/contracts-signed/..., categoria dedicada e
 * DIFERENTE da usada pelo PDF não-assinado, que nunca é persistido — ver contractPdf.service.js
 * e a migration 20260101000180 pra decisão de engenharia completa). Idempotente: se a
 * ContractVersion já tiver `signedDocumentFileId`, não baixa de novo nem duplica o File.
 *
 * NÃO testado ao vivo contra um fechamento de envelope real nesta sessão (ver ressalva em
 * ClicksignSignatureAdapter#downloadSignedDocument) — completar um ciclo real de assinatura
 * exige interação humana de terceiro fora do nosso controle. Validado por leitura de
 * documentação oficial + inspeção do fluxo de webhook já existente e testado
 * (`clicksignPublicWebhook`/roteamento por `SignatureProviderRouting`).
 */
async function handleEnvelopeClosedWebhook(providerEnvelopeId, tenant, transaction) {
  const routing = await SignatureProviderRouting.findOne({ where: { providerEnvelopeId }, transaction });
  if (!routing) {
    return { acknowledged: true, processed: false, reason: 'unknown_envelope' };
  }

  const signature = await Signature.findOne({ where: { providerEnvelopeId }, transaction });
  if (!signature) {
    return { acknowledged: true, processed: false, reason: 'no_signature_for_envelope' };
  }

  const contractVersion = await ContractVersion.findByPk(signature.contractVersionId, { transaction });
  if (!contractVersion) {
    return { acknowledged: true, processed: false, reason: 'contract_version_not_found' };
  }
  if (contractVersion.signedDocumentFileId) {
    // Idempotência: webhook duplicado (close + auto_close pro mesmo envelope, ou reentrega do
    // provedor) não deve baixar/gravar o documento assinado de novo.
    return { acknowledged: true, processed: false, reason: 'already_downloaded', fileId: contractVersion.signedDocumentFileId };
  }

  const adapter = await resolveSignatureAdapter(tenant, transaction);
  const downloaded = await adapter.downloadSignedDocument(providerEnvelopeId);
  if (!downloaded || !downloaded.buffer || downloaded.buffer.length === 0) {
    return { acknowledged: true, processed: false, reason: 'no_document_available' };
  }

  const contract = await getContract(contractVersion.contractId, transaction);
  const safeContractNumber = String(contract.contractNumber || contract.id).replace(/[^a-zA-Z0-9-]/g, '_');
  const fileName = downloaded.fileName || `contrato-assinado-${safeContractNumber}.pdf`;
  const storageKey = diskStorage.saveFile('contracts-signed', contract.groupId, fileName, downloaded.buffer);

  const checksumSha256 = crypto.createHash('sha256').update(downloaded.buffer).digest('hex');

  const file = await File.create(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      storageKey,
      fileName,
      mimeType: 'application/pdf',
      sizeBytes: downloaded.buffer.length,
      checksumSha256,
      uploadedByUserId: null,
      createdBy: null,
      updatedBy: null,
    },
    { transaction }
  );

  contractVersion.signedDocumentFileId = file.id;
  contractVersion.updatedBy = null;
  await contractVersion.save({ transaction });

  await registrarAuditoria(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      actorUserId: null,
      action: 'legal.contract_version.signed_document_downloaded',
      entityType: 'ContractVersion',
      entityId: contractVersion.id,
      afterJson: { fileId: file.id, storageKey, sizeBytes: downloaded.buffer.length, checksumSha256 },
      reason: `Documento assinado do contrato ${contract.contractNumber || contract.id} baixado do provedor e salvo permanentemente (envelope ${providerEnvelopeId} fechado).`,
    },
    transaction
  );

  return { acknowledged: true, processed: true, fileId: file.id };
}

module.exports = {
  initiateSignature,
  listSignaturesByContractVersion,
  handleSignatureWebhook,
  handleEnvelopeClosedWebhook,
  resolveSignatureAdapter,
  checkSignatureStatus,
  cancelSignature,
};
