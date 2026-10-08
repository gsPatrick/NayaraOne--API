'use strict';

const {
  InsurancePolicy,
  InsurancePolicyParty,
  InsuranceCoverage,
  InsuranceInstallment,
  InsuranceClaim,
  InsuranceClaimEvent,
  InsuranceRenewalTask,
  InsuranceProviderSubmission,
  FinancialEntry,
  File,
  FileLink,
} = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { resolveInsuranceAdapter } = require('./adapters/resolveInsuranceAdapter');
const { createFinancialEntry } = require('../finance/financialEntries.service');
const { getOrCreateDefaultResultCenter } = require('../finance/resultCenters.service');
const { getSetting } = require('../settings/settings.service');
const filesService = require('../files/files.service');

// Insurance Hub (Marco 7, contrato 00000009 Anexo I — "COMPRAS/PROCUREMENT + SEGUROS"):
// "policies, parties, coverages, installments, claims, claim_events, renewal_tasks,
// provider_submissions. Apólice com provider/número/vigência/cobertura/prêmio/documentos;
// renovação alerta; sinistro timeline; indenização confirmada integra Financeiro."
//
// Mesmo princípio já usado em bankPayments.service.js: o caminho NOVO (via adapter) nunca
// presume sucesso — só confirmSettlement (webhook/polling) grava ledger, e só quando o status
// reportado pela seguradora é de fato liquidação confirmada.

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 5, 2026-10-05): `quoteSnapshot`
// guardava o `raw` inteiro devolvido pelo adapter — que embute o `req` de cotação enviado,
// contendo CPF (`PublicIdNumber`), renda mensal, dados do cônjuge e endereço completo do
// locatário (schema `TenantData` documentado em `adapters/InsuranceAdapter.js`), em texto
// claro, sem máscara nem hash. Isso desviava do padrão já estabelecido no projeto pro mesmo
// dado (CPF) — `src/models/Person.js` mantém `taxIdNormalized` mascarado na camada de
// aplicação + `taxIdNormalizedHash` (HMAC) pra busca, nunca o valor cru solto num JSONB.
// `redactPii` varre recursivamente o objeto e mascara qualquer chave que bata com um padrão
// conhecido de PII — funciona para qualquer formato de resposta de provider (Yelum, Porto
// Seguro, Sandbox), não só o schema específico de um deles.
const PII_KEY_PATTERN = /cpf|cnpj|publicidnumber|income|renda|birthdate|salary|telephonenumber|cellphonenumber|celularnumber|\bemail\b|zipcode|streetname|streetnumber|ownertelephonenumber/i;

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 55, 2026-10-05): aritmética de datas
// DATEONLY ("YYYY-MM-DD") nunca pode passar por `new Date(str)` + `.getDate()/.setDate()` —
// esses métodos leem/escrevem no fuso LOCAL do servidor, enquanto `new Date("YYYY-MM-DD")" é
// interpretado como UTC midnight. Em qualquer servidor com offset negativo (Brasil, UTC-3),
// isso trunca o dia pro anterior antes de somar/subtrair, gravando a data errada em 1 dia.
// Opera só em componentes UTC e devolve string "YYYY-MM-DD", nunca convertendo pra fuso local.
function addDaysDateOnly(dateOnlyStr, days) {
  const [year, month, day] = String(dateOnlyStr).slice(0, 10).split('-').map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  utcDate.setUTCDate(utcDate.getUTCDate() + days);
  return utcDate.toISOString().slice(0, 10);
}

// Mesmo cuidado de `addDaysDateOnly`, pra meses em vez de dias — usado por `generateInstallments`.
function addMonthsDateOnly(dateOnlyStr, months) {
  const [year, month, day] = String(dateOnlyStr).slice(0, 10).split('-').map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  utcDate.setUTCMonth(utcDate.getUTCMonth() + months);
  return utcDate.toISOString().slice(0, 10);
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function redactPii(value) {
  if (Array.isArray(value)) return value.map(redactPii);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = PII_KEY_PATTERN.test(key) ? '[REDACTED]' : redactPii(val);
    }
    return out;
  }
  return value;
}

async function createPolicy(payload, actorUserId, transaction) {
  const { groupId, companyId, propertyId, contractId, coverageSummary, parties } = payload;
  if (!groupId || !companyId) {
    throw AppError.badRequest('Os campos "groupId" e "companyId" são obrigatórios.', 'INSURANCE_POLICY_VALIDATION');
  }

  const policy = await InsurancePolicy.create(
    {
      groupId,
      companyId,
      propertyId: propertyId || null,
      contractId: contractId || null,
      coverageSummary: coverageSummary || null,
      status: 'DRAFT',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  if (Array.isArray(parties)) {
    for (const party of parties) {
      if (!party.partyRole) continue;
      await InsurancePolicyParty.create(
        { groupId, companyId, policyId: policy.id, partyRole: party.partyRole, personId: party.personId || null },
        { transaction }
      );
    }
  }

  await registrarAuditoria(
    {
      groupId, companyId, actorUserId,
      action: 'procurement.insurance_policy.create',
      entityType: 'InsurancePolicy', entityId: policy.id,
      beforeJson: null, afterJson: policy.toJSON(),
      reason: 'Apólice criada (rascunho).',
    },
    transaction
  );

  return policy;
}

async function getPolicyForUpdate(id, transaction) {
  const policy = await InsurancePolicy.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!policy) throw AppError.notFound('Apólice não encontrada.', 'INSURANCE_POLICY_NOT_FOUND');
  return policy;
}

// Cotação: NÃO altera estado, só consulta o adapter e grava o snapshot bruto — útil pra
// comparar provider antes de decidir emitir.
// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 8, 2026-10-05): o contrato pede
// apólice com "...prêmio/documentos..." — a Yelum já devolve o documento da análise cadastral
// embutido na resposta de cotação (`Data.File`, base64, documentado em InsuranceAdapter.js),
// mas isso era descartado dentro do `quoteSnapshot` bruto, nunca virava um `File`/`FileLink`
// de verdade (padrão já usado pelo Jurídico em `inspections.service.js`). Extrai e persiste via
// o mesmo mecanismo, e some do JSONB bruto pra não duplicar um blob base64 grande ali dentro.
function extractEmbeddedDocument(raw) {
  const base64 = raw?.Data?.File;
  if (typeof base64 !== 'string' || base64.length === 0) return null;
  return { contentBase64: base64, fileName: `cotacao-seguro-${Date.now()}.pdf`, mimeType: 'application/pdf' };
}

async function quotePolicy(id, quoteRequest, actor, transaction) {
  const policy = await getPolicyForUpdate(id, transaction);
  const adapter = await resolveInsuranceAdapter({ groupId: policy.groupId, companyId: policy.companyId }, transaction);
  const quote = await adapter.quote(quoteRequest || {});

  const embeddedDoc = extractEmbeddedDocument(quote.raw);
  const rawForSnapshot = embeddedDoc && quote.raw?.Data
    ? { ...quote.raw, Data: { ...quote.raw.Data, File: '[ARMAZENADO_COMO_ARQUIVO]' } }
    : quote.raw;

  policy.quoteSnapshot = redactPii(rawForSnapshot);
  policy.premiumAmount = quote.premiumAmount ?? policy.premiumAmount;
  policy.coverageSummary = quote.coverageSummary || policy.coverageSummary;
  policy.status = 'QUOTED';
  policy.updatedBy = actor.userId || null;
  await policy.save({ transaction });

  if (embeddedDoc) {
    const file = await filesService.uploadFile(
      {
        groupId: policy.groupId,
        companyId: policy.companyId,
        fileName: embeddedDoc.fileName,
        mimeType: embeddedDoc.mimeType,
        contentBase64: embeddedDoc.contentBase64,
        category: 'insurance',
      },
      actor.userId,
      transaction
    );
    await FileLink.create(
      {
        groupId: policy.groupId,
        companyId: policy.companyId,
        fileId: file.id,
        relatedEntityType: 'InsurancePolicy',
        relatedEntityId: policy.id,
        purpose: 'QUOTE_DOCUMENT',
        createdBy: actor.userId || null,
        updatedBy: actor.userId || null,
      },
      { transaction }
    );
  }

  return policy;
}

// Anexo manual de documento à apólice (ex.: PDF da apólice assinada, laudo) — mesmo padrão de
// `attachInspectionItemMedia` no Jurídico: arquivo já precisa existir (upload via POST /files
// separado), aqui só cria o vínculo.
async function attachPolicyDocument(policyId, fileId, actor, transaction) {
  const policy = await InsurancePolicy.findByPk(policyId, { transaction });
  if (!policy) throw AppError.notFound('Apólice não encontrada.', 'INSURANCE_POLICY_NOT_FOUND');
  if (!fileId) {
    throw AppError.badRequest('O campo "fileId" é obrigatório (arquivo precisa existir antes de vincular).', 'INSURANCE_POLICY_DOCUMENT_VALIDATION');
  }
  const file = await File.findByPk(fileId, { transaction });
  if (!file) throw AppError.notFound('Arquivo não encontrado.', 'INSURANCE_POLICY_DOCUMENT_FILE_NOT_FOUND');

  const link = await FileLink.create(
    {
      groupId: policy.groupId,
      companyId: policy.companyId,
      fileId,
      relatedEntityType: 'InsurancePolicy',
      relatedEntityId: policy.id,
      purpose: 'MANUAL',
      createdBy: actor.userId || null,
      updatedBy: actor.userId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId: policy.groupId, companyId: policy.companyId, actorUserId: actor.userId,
      action: 'procurement.insurance_policy.attach_document',
      entityType: 'InsurancePolicy', entityId: policy.id,
      afterJson: { fileLinkId: link.id, fileId },
      reason: 'Documento anexado manualmente à apólice.',
    },
    transaction
  );

  return link;
}

async function listPolicyDocuments(policyId, transaction) {
  return FileLink.findAll({
    where: { relatedEntityType: 'InsurancePolicy', relatedEntityId: policyId },
    order: [['created_at', 'DESC']],
    transaction,
  });
}

// Emissão: idempotente via idempotencyKey = `insurance-policy:{id}`, mesmo padrão de
// submitPaymentIntentToBank. Nunca presume ACTIVE — o adapter retorna o status real
// (Sandbox confirma na hora; provider real pode devolver "em análise").
async function issuePolicy(id, issueRequest, actor, transaction) {
  const policy = await getPolicyForUpdate(id, transaction);
  if (!['DRAFT', 'QUOTED'].includes(policy.status)) {
    throw AppError.conflict(`Apólice com status "${policy.status}" não pode ser emitida.`, 'INSURANCE_POLICY_INVALID_STATUS');
  }

  // BUG REAL CORRIGIDO (auditoria "loop até secar", Ciclo 1, Seguros, 2026-10-06): nada validava
  // a vigência informada na emissão — uma data de vencimento igual, anterior, ou simplesmente
  // inválida (string não-parseável) à data de início era aceita de cara, gravando uma apólice
  // "ativa" cuja janela de vigência é vazia ou invertida. Isso também corrompe silenciosamente
  // `addDaysDateOnly(expiryDate, -30)` (renewal task nasceria com dueDate != esperado) e
  // `generateInstallments` (parcelas vencendo numa ordem sem sentido). Mesmo padrão de
  // validação fail-closed já usado no resto do arquivo (ex.: claimAmount em `openClaim`).
  // Validado ANTES de chamar o adapter — não há motivo pra gastar uma chamada externa (e
  // possivelmente consumir idempotencyKey do provider real) com uma vigência já sabida inválida.
  const nextEffectiveDate = issueRequest?.effectiveDate || policy.effectiveDate;
  const nextExpiryDate = issueRequest?.expiryDate || policy.expiryDate;
  if (nextEffectiveDate && nextExpiryDate) {
    const effectiveTime = Date.parse(String(nextEffectiveDate).slice(0, 10));
    const expiryTime = Date.parse(String(nextExpiryDate).slice(0, 10));
    if (!Number.isFinite(effectiveTime) || !Number.isFinite(expiryTime)) {
      throw AppError.badRequest(
        '"effectiveDate" e "expiryDate" precisam ser datas válidas (YYYY-MM-DD).',
        'INSURANCE_POLICY_VALIDATION'
      );
    }
    if (expiryTime <= effectiveTime) {
      throw AppError.badRequest(
        '"expiryDate" precisa ser posterior a "effectiveDate" — vigência vazia ou invertida não é permitida.',
        'INSURANCE_POLICY_VALIDATION'
      );
    }
  }

  const tenant = { groupId: policy.groupId, companyId: policy.companyId };
  const providerName = await getSetting('procurement.insurance_provider', tenant, transaction, 'sandbox');
  const idempotencyKey = `insurance-policy:${policy.id}`;
  const adapter = await resolveInsuranceAdapter(tenant, transaction);
  const issued = await adapter.issuePolicy({ ...issueRequest, idempotencyKey });

  const beforeJson = policy.toJSON();
  policy.provider = providerName;
  policy.externalPolicyNumber = issued.policyNumber || policy.externalPolicyNumber;
  policy.status = issued.status === 'ACTIVE' ? 'ACTIVE' : 'ISSUED';
  policy.effectiveDate = nextEffectiveDate;
  policy.expiryDate = nextExpiryDate;
  policy.updatedBy = actor.userId || null;
  await policy.save({ transaction });

  await InsuranceProviderSubmission.create(
    {
      groupId: policy.groupId, companyId: policy.companyId, policyId: policy.id,
      provider: providerName,
      submissionType: 'ISSUE',
      externalSubmissionId: issued.externalId,
      status: issued.status,
    },
    { transaction }
  );

  // Renovação: tarefa de alerta criada já na emissão, não depois — "renovação alerta" é
  // requisito do próprio contrato (Insurance Hub). 30 dias antes do vencimento por padrão.
  //
  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 55, 2026-10-05): `expiryDate` é
  // DATEONLY — o Sequelize devolve a string "YYYY-MM-DD". `new Date("2026-12-31")` é
  // interpretado como UTC midnight, mas `.getDate()`/`.setDate()` operam no fuso LOCAL do
  // servidor. Em qualquer servidor com offset negativo (Brasil, UTC-3), isso trunca o dia pra
  // o anterior ANTES de subtrair os 30 dias — a tarefa nascia gravada um dia antes do correto.
  // `addDaysDateOnly` opera só em componentes UTC/string, nunca convertendo pra fuso local.
  if (policy.expiryDate) {
    const dueDate = addDaysDateOnly(policy.expiryDate, -30);
    await InsuranceRenewalTask.create(
      { groupId: policy.groupId, companyId: policy.companyId, policyId: policy.id, dueDate, status: 'PENDING' },
      { transaction }
    );
  }

  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 11, 2026-10-05): o contrato lista
  // "parcelas" como campo da apólice (seguro-fiança, linha 8179) e "installments" como entidade
  // própria do Insurance Hub (linha 9514) — a migration/model já existiam, mas nada no sistema
  // jamais criava uma linha: `generateInstallments` divide o prêmio em N parcelas (padrão já
  // usado em `commissions.service.js` para Commission/CommissionInstallment), a última parcela
  // absorve a diferença de arredondamento de centavos.
  const installments = policy.premiumAmount
    ? await generateInstallments(policy, issueRequest?.installmentsCount || 1, policy.effectiveDate, transaction)
    : [];

  await registrarAuditoria(
    {
      groupId: policy.groupId, companyId: policy.companyId, actorUserId: actor.userId,
      action: 'procurement.insurance_policy.issue',
      entityType: 'InsurancePolicy', entityId: policy.id,
      beforeJson, afterJson: policy.toJSON(),
      reason: `Apólice emitida — id externo ${issued.externalId}.`,
    },
    transaction
  );

  policy.setDataValue('installments', installments);
  return policy;
}

async function generateInstallments(policy, count, firstDueAt, transaction) {
  const n = Math.max(1, Number(count) || 1);
  const baseInstallment = Math.floor((policy.premiumAmount / n) * 100) / 100;
  const installments = [];
  let allocated = 0;
  // BUG REAL CORRIGIDO (rodada 55): mesmo risco de fuso horário de addDaysDateOnly, aqui pra
  // meses — `firstDueAt` normalmente é `policy.effectiveDate` (DATEONLY).
  const startDateOnly = firstDueAt
    ? String(firstDueAt).slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  for (let i = 1; i <= n; i += 1) {
    const isLast = i === n;
    const amount = isLast ? round2(policy.premiumAmount - allocated) : baseInstallment;
    allocated = round2(allocated + amount);

    const dueDate = addMonthsDateOnly(startDateOnly, i - 1);

    // eslint-disable-next-line no-await-in-loop
    const installment = await InsuranceInstallment.create(
      {
        groupId: policy.groupId,
        companyId: policy.companyId,
        policyId: policy.id,
        dueDate,
        amount,
        status: 'PENDING',
      },
      { transaction }
    );
    installments.push(installment);
  }

  return installments;
}

async function listPolicyInstallments(policyId, transaction) {
  return InsuranceInstallment.findAll({ where: { policyId }, order: [['due_date', 'ASC']], transaction });
}

// payInsurancePolicyInstallment — mesmo padrão de validação fail-closed de
// `commissions.service.js#markInstallmentPaid`: a parcela só vira PAID se apontar pra um
// FinancialEntry que já existe, está SETTLED, tem o mesmo valor, e ainda não foi usado por
// outra parcela — nunca aceita a baixa "porque alguém clicou no botão".
async function payInsurancePolicyInstallment(installmentId, financialEntryId, actor, transaction) {
  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 40, 2026-10-05): faltava lock
  // pessimista aqui — getPolicyForUpdate/getClaimForUpdate (mesmo arquivo) já usam
  // `lock: transaction.LOCK.UPDATE` pra qualquer transição financeira/de status, mas esta
  // função lia a parcela sem lock. Como cada requisição HTTP abre sua própria transação (sem
  // serialização externa), duas chamadas concorrentes de pay poderiam ambas passar pela
  // checagem `alreadyUsed` antes de qualquer commit e marcar duas parcelas diferentes como
  // PAID usando o MESMO financialEntryId — dupla contagem de um único pagamento real.
  const installment = await InsuranceInstallment.findByPk(installmentId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!installment) throw AppError.notFound('Parcela de seguro não encontrada.', 'INSURANCE_INSTALLMENT_NOT_FOUND');
  if (installment.status === 'PAID') {
    throw AppError.conflict('Esta parcela já está paga.', 'INSURANCE_INSTALLMENT_ALREADY_PAID');
  }
  if (!financialEntryId) {
    throw AppError.badRequest(
      'O campo "financialEntryId" é obrigatório para dar baixa na parcela — precisa apontar para um lançamento financeiro já liquidado.',
      'INSURANCE_INSTALLMENT_ENTRY_REQUIRED'
    );
  }
  // Trava o FinancialEntry também — é o recurso compartilhado que duas parcelas DIFERENTES
  // disputam (ambas apontando pro mesmo financialEntryId). Travar só a installment não
  // serializa essa corrida, já que são linhas distintas.
  const entry = await FinancialEntry.findByPk(financialEntryId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!entry) throw AppError.notFound('Lançamento financeiro informado não encontrado.', 'INSURANCE_INSTALLMENT_ENTRY_NOT_FOUND');
  if (entry.status !== 'SETTLED') {
    throw AppError.conflict('O lançamento financeiro informado ainda não está liquidado (SETTLED).', 'INSURANCE_INSTALLMENT_ENTRY_NOT_SETTLED');
  }
  if (round2(entry.amount) !== round2(installment.amount)) {
    throw AppError.conflict('O valor do lançamento financeiro informado não corresponde ao valor da parcela.', 'INSURANCE_INSTALLMENT_ENTRY_AMOUNT_MISMATCH');
  }
  const alreadyUsed = await InsuranceInstallment.findOne({ where: { financialEntryId }, transaction });
  if (alreadyUsed && alreadyUsed.id !== installment.id) {
    throw AppError.conflict('Este lançamento financeiro já foi usado para dar baixa em outra parcela.', 'INSURANCE_INSTALLMENT_ENTRY_ALREADY_USED');
  }

  const beforeJson = installment.toJSON();
  installment.status = 'PAID';
  installment.financialEntryId = financialEntryId;
  await installment.save({ transaction });

  await registrarAuditoria(
    {
      groupId: installment.groupId, companyId: installment.companyId, actorUserId: actor.userId,
      action: 'procurement.insurance_installment.pay',
      entityType: 'InsuranceInstallment', entityId: installment.id,
      beforeJson, afterJson: installment.toJSON(),
      reason: `Parcela do seguro paga (${installment.amount}).`,
    },
    transaction
  );

  return installment;
}

async function openClaim(policyId, payload, actor, transaction) {
  const policy = await getPolicyForUpdate(policyId, transaction);
  if (!['ACTIVE', 'ISSUED'].includes(policy.status)) {
    throw AppError.conflict(`Apólice com status "${policy.status}" não pode abrir sinistro.`, 'INSURANCE_POLICY_INVALID_STATUS');
  }

  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 56, 2026-10-06): claimAmount era
  // persistido sem validação de tipo/sinal — um valor negativo/inválido digitado errado ficava
  // gravado no InsuranceClaim até confirmClaimSettlement rejeitar o sinistro mais adiante.
  if (payload?.claimAmount != null) {
    const amount = Number(payload.claimAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      throw AppError.badRequest('"claimAmount" deve ser um número maior ou igual a zero.', 'INSURANCE_CLAIM_VALIDATION');
    }
  }

  const claim = await InsuranceClaim.create(
    {
      groupId: policy.groupId, companyId: policy.companyId, policyId: policy.id,
      description: payload?.description || null,
      claimAmount: payload?.claimAmount || null,
      status: 'OPEN',
      openedAt: new Date(),
      createdBy: actor.userId || null,
      updatedBy: actor.userId || null,
    },
    { transaction }
  );

  await InsuranceClaimEvent.create(
    { groupId: policy.groupId, companyId: policy.companyId, claimId: claim.id, eventType: 'OPENED', actorUserId: actor.userId || null, occurredAt: new Date() },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId: policy.groupId, companyId: policy.companyId, actorUserId: actor.userId,
      action: 'procurement.insurance_claim.open',
      entityType: 'InsuranceClaim', entityId: claim.id,
      beforeJson: null, afterJson: claim.toJSON(),
      reason: 'Sinistro aberto.',
    },
    transaction
  );

  return claim;
}

async function getClaimForUpdate(id, transaction) {
  const claim = await InsuranceClaim.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!claim) throw AppError.notFound('Sinistro não encontrado.', 'INSURANCE_CLAIM_NOT_FOUND');
  return claim;
}

async function submitClaim(claimId, actor, transaction) {
  const claim = await getClaimForUpdate(claimId, transaction);
  if (claim.status !== 'OPEN') {
    throw AppError.conflict(`Sinistro com status "${claim.status}" não pode ser submetido.`, 'INSURANCE_CLAIM_INVALID_STATUS');
  }
  const policy = await InsurancePolicy.findByPk(claim.policyId, { transaction });

  const idempotencyKey = `insurance-claim:${claim.id}`;
  const adapter = await resolveInsuranceAdapter({ groupId: claim.groupId, companyId: claim.companyId }, transaction);
  const submitted = await adapter.submitClaim({
    idempotencyKey,
    externalPolicyNumber: policy?.externalPolicyNumber,
    description: claim.description,
    claimAmount: claim.claimAmount,
  });

  const beforeJson = claim.toJSON();
  claim.externalClaimId = submitted.externalId;
  claim.status = 'SUBMITTED';
  claim.updatedBy = actor.userId || null;
  await claim.save({ transaction });

  await InsuranceProviderSubmission.create(
    {
      groupId: claim.groupId, companyId: claim.companyId, claimId: claim.id,
      provider: policy?.provider || 'sandbox',
      submissionType: 'CLAIM',
      externalSubmissionId: submitted.externalId,
      status: submitted.status,
    },
    { transaction }
  );

  await InsuranceClaimEvent.create(
    { groupId: claim.groupId, companyId: claim.companyId, claimId: claim.id, eventType: 'SUBMITTED', actorUserId: actor.userId || null, occurredAt: new Date() },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId: claim.groupId, companyId: claim.companyId, actorUserId: actor.userId,
      action: 'procurement.insurance_claim.submit',
      entityType: 'InsuranceClaim', entityId: claim.id,
      beforeJson, afterJson: claim.toJSON(),
      reason: `Sinistro submetido à seguradora — id externo ${submitted.externalId}.`,
    },
    transaction
  );

  return claim;
}

// Chamado por webhook do provedor OU por confirmação manual — idempotente: reprocessar o mesmo
// status num claim que já saiu de SUBMITTED/UNDER_REVIEW é no-op. "Indenização confirmada
// integra Financeiro" (contrato) — só AQUI, na confirmação real, nunca na submissão.
// BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-07; contrato, Centro Financeiro
// BLINDADO v1, §4: "Centro de resultado obrigatório para receita"): confirmClaimSettlement
// criava um lançamento RECEIVABLE (indenização de sinistro) sem nenhum resultCenterId — a
// confirmação chega por webhook da seguradora, que não tem como informar essa dimensão. Usa
// getOrCreateDefaultResultCenter (ver resultCenters.service.js) com um código dedicado.
const INSURANCE_RESULT_CENTER_CODE = 'SEGUROS-INDENIZACOES';

async function confirmClaimSettlement(externalSubmissionId, externalStatus, settledAmount, transaction) {
  const submission = await InsuranceProviderSubmission.findOne({ where: { externalSubmissionId }, transaction });
  if (!submission || !submission.claimId) {
    throw AppError.notFound('Nenhum sinistro encontrado para este id externo.', 'INSURANCE_CLAIM_SUBMISSION_NOT_FOUND');
  }

  const claim = await getClaimForUpdate(submission.claimId, transaction);
  if (!['SUBMITTED', 'UNDER_REVIEW'].includes(claim.status)) {
    return claim;
  }

  const beforeJson = claim.toJSON();
  // Bug real encontrado em auditoria (2026-10-05): se nem `settledAmount` (vindo do
  // webhook/confirmação manual) nem `claim.claimAmount` (vindo da abertura do sinistro, campo
  // opcional) existirem, `createFinancialEntry` lança FINANCE_ENTRY_VALIDATION — e isso
  // acontecia DENTRO da transação do webhook público, vazando um erro cru em vez do padrão
  // 200+reason já usado pro resto desse mesmo endpoint (routing desconhecido, payload
  // inválido). Validado ANTES de chamar o Financeiro, igual aos outros casos de falha.
  const resolvedAmount = settledAmount || claim.claimAmount;
  if ((externalStatus === 'SETTLED' || externalStatus === 'APPROVED') && !(Number(resolvedAmount) > 0)) {
    claim.status = 'REJECTED';
    await claim.save({ transaction });
    await InsuranceClaimEvent.create(
      {
        groupId: claim.groupId, companyId: claim.companyId, claimId: claim.id, eventType: 'REJECTED',
        notes: 'Seguradora confirmou liquidação, mas nenhum valor (settledAmount/claimAmount) estava disponível para gerar o lançamento — revisão manual necessária.',
        occurredAt: new Date(),
      },
      { transaction }
    );
    await registrarAuditoria(
      {
        groupId: claim.groupId, companyId: claim.companyId, actorUserId: null,
        action: 'procurement.insurance_claim.settlement_missing_amount',
        entityType: 'InsuranceClaim', entityId: claim.id,
        beforeJson, afterJson: claim.toJSON(),
        reason: 'Confirmação de liquidação recebida sem valor utilizável — marcado para revisão manual em vez de criar lançamento com amount inválido.',
      },
      transaction
    );
    return claim;
  }

  if (externalStatus === 'SETTLED' || externalStatus === 'APPROVED') {
    const policy = await InsurancePolicy.findByPk(claim.policyId, { transaction });
    const resultCenter = await getOrCreateDefaultResultCenter(
      claim.groupId,
      claim.companyId,
      INSURANCE_RESULT_CENTER_CODE,
      'Indenizações de seguro',
      transaction
    );
    const entry = await createFinancialEntry(
      {
        groupId: claim.groupId,
        companyId: claim.companyId,
        contractId: policy?.contractId || null,
        entryType: 'CREDIT',
        nature: 'RECEIVABLE',
        amount: resolvedAmount,
        description: `Indenização de sinistro de seguro — apólice ${policy?.externalPolicyNumber || policy?.id}`,
        dueAt: new Date(),
        resultCenterId: resultCenter.id,
      },
      null,
      transaction
    );

    claim.financialEntryId = entry.id;
    claim.settledAmount = resolvedAmount;
    claim.status = 'SETTLED';
    claim.settledAt = new Date();
    await claim.save({ transaction });

    await InsuranceClaimEvent.create(
      { groupId: claim.groupId, companyId: claim.companyId, claimId: claim.id, eventType: 'SETTLED', notes: `Lançamento ${entry.id} criado.`, occurredAt: new Date() },
      { transaction }
    );

    await registrarAuditoria(
      {
        groupId: claim.groupId, companyId: claim.companyId, actorUserId: null,
        action: 'procurement.insurance_claim.settle',
        entityType: 'InsuranceClaim', entityId: claim.id,
        beforeJson, afterJson: claim.toJSON(),
        reason: `Indenização confirmada — lançamento ${entry.id} criado no Financeiro.`,
      },
      transaction
    );
  } else {
    claim.status = 'REJECTED';
    await claim.save({ transaction });

    await InsuranceClaimEvent.create(
      { groupId: claim.groupId, companyId: claim.companyId, claimId: claim.id, eventType: 'REJECTED', notes: `Status retornado pela seguradora: ${externalStatus}`, occurredAt: new Date() },
      { transaction }
    );

    await registrarAuditoria(
      {
        groupId: claim.groupId, companyId: claim.companyId, actorUserId: null,
        action: 'procurement.insurance_claim.reject',
        entityType: 'InsuranceClaim', entityId: claim.id,
        beforeJson, afterJson: claim.toJSON(),
        reason: `Sinistro recusado pela seguradora — status "${externalStatus}".`,
      },
      transaction
    );
  }

  return claim;
}

async function listPolicies(filters, transaction) {
  const where = {};
  if (filters?.status) where.status = filters.status;
  if (filters?.propertyId) where.propertyId = filters.propertyId;
  return InsurancePolicy.findAll({
    where,
    include: [
      { model: InsuranceCoverage, as: 'coverages' },
      { model: InsuranceClaim, as: 'claims' },
      { model: InsuranceRenewalTask, as: 'renewalTasks' },
    ],
    order: [['created_at', 'DESC']],
    transaction,
  });
}

async function getPolicy(id, transaction) {
  const policy = await InsurancePolicy.findByPk(id, {
    include: [
      { model: InsurancePolicyParty, as: 'parties' },
      { model: InsuranceCoverage, as: 'coverages' },
      { model: InsuranceInstallment, as: 'installments' },
      { model: InsuranceClaim, as: 'claims', include: [{ model: InsuranceClaimEvent, as: 'events' }] },
      { model: InsuranceRenewalTask, as: 'renewalTasks' },
    ],
    transaction,
  });
  if (!policy) throw AppError.notFound('Apólice não encontrada.', 'INSURANCE_POLICY_NOT_FOUND');
  return policy;
}

module.exports = {
  createPolicy,
  quotePolicy,
  issuePolicy,
  openClaim,
  submitClaim,
  confirmClaimSettlement,
  listPolicies,
  getPolicy,
  attachPolicyDocument,
  listPolicyDocuments,
  extractEmbeddedDocument,
  listPolicyInstallments,
  payInsurancePolicyInstallment,
};
