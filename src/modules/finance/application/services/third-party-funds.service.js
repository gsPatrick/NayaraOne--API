'use strict';

/**
 * Dinheiro de terceiro (caução, depósito de garantia, repasse ao proprietário) — Caderno §13 e F04/D1/D2/D3 da
 * revisão independente: vínculo com contrato e titular, saldo da caução de origem e dívida compensada.
 */
const AppError = require('../../../../utils/AppError');
const entries = require('../../infrastructure/repositories/financial-entry.repository');
const { computeRemainingAmount, computeThirdPartyOriginBalance } = require('./ledger-balance.service');
const { toCents, fromCents } = require('../../domain/ledger-movement');
const {
  RECEIVED_STATUSES,
  OPEN_FOR_SETTLEMENT_STATUSES,
  THIRD_PARTY_HOLDER_ROLES,
  THIRD_PARTY_RELEASE_TYPES,
  isThirdPartyRelease,
} = require('../../domain/financial-entry');

// D1/D3 (revisão independente): a liquidação de uma devolução/compensação de caução revalida o
// saldo da origem com lock (a validação só na criação deixava liquidar depois que a origem foi
// estornada, ou com saldo já consumido).
async function assertThirdPartyReleaseStillCovered(entry, transaction) {
  if (!isThirdPartyRelease(entry)) return;
  const origin = await entries.findInCompanyForUpdate(entry.thirdPartyOriginEntryId, entry.companyId, transaction);
  if (!origin || !RECEIVED_STATUSES.includes(origin.status)) {
    throw AppError.conflict(
      'A caução de origem desta devolução não está mais recebida (foi estornada ou cancelada) — a devolução não pode ser paga.',
      'FINANCE_THIRD_PARTY_ORIGIN_NOT_RECEIVED'
    );
  }
  const balance = await computeThirdPartyOriginBalance(origin, transaction);
  if (toCents(balance.available) < 0) {
    throw AppError.conflict(
      `As saídas desta caução (${balance.released}) passam do valor recebido (${balance.received}).`,
      'FINANCE_THIRD_PARTY_RELEASE_EXCEEDS_BALANCE',
      { available: balance.available, received: balance.received, released: balance.released }
    );
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function assertContractOfCompany(contractId, companyId, transaction) {
  if (typeof contractId !== 'string' || !UUID_RE.test(contractId) || !(await entries.findContractOfCompany(contractId, companyId, transaction))) {
    throw AppError.badRequest('O contrato informado não existe nesta empresa: o lançamento só se vincula a contrato da própria empresa.', 'FINANCE_ENTRY_CONTRACT_NOT_IN_COMPANY');
  }
}

// D2 (revisão independente): o titular podia ser qualquer parte do contrato (o proprietário foi
// aceito como "dono" da caução).
async function assertThirdPartyHolderIsContractParty(holderPersonId, contractId, transaction) {
  const person = await entries.findPerson(holderPersonId, transaction);
  if (!person) {
    throw AppError.badRequest('Titular do dinheiro de terceiro não encontrado.', 'FINANCE_THIRD_PARTY_HOLDER_NOT_FOUND');
  }
  const parties = await entries.findContractParties(contractId, holderPersonId, transaction);
  if (parties.length === 0) {
    throw AppError.badRequest(
      'O titular informado não é parte do contrato — o dinheiro de terceiro precisa pertencer a uma parte do contrato.',
      'FINANCE_THIRD_PARTY_HOLDER_NOT_CONTRACT_PARTY'
    );
  }
  if (!parties.some((party) => THIRD_PARTY_HOLDER_ROLES.includes(party.partyRole))) {
    throw AppError.badRequest(
      `O titular da caução precisa ser locatário, comprador ou fiador do contrato (papel atual: ${parties.map((p) => p.partyRole).join(', ')}).`,
      'FINANCE_THIRD_PARTY_HOLDER_ROLE_INVALID'
    );
  }
}

// D3 (revisão independente): a compensação aponta a dívida do titular que ela abate.
async function resolveCompensatedDebt({ companyId, compensatedEntryId, contractId, holderPersonId, amount }, transaction) {
  if (!compensatedEntryId) {
    throw AppError.badRequest(
      'Informe a dívida do titular que está sendo compensada com a caução.',
      'FINANCE_THIRD_PARTY_COMPENSATED_DEBT_REQUIRED'
    );
  }
  const debt = await entries.findInCompanyForUpdate(compensatedEntryId, companyId, transaction);
  if (!debt) {
    throw AppError.notFound('Dívida a compensar não encontrada nesta empresa.', 'FINANCE_THIRD_PARTY_COMPENSATED_DEBT_NOT_FOUND');
  }
  if (debt.nature !== 'RECEIVABLE' || debt.isThirdPartyFunds || !OPEN_FOR_SETTLEMENT_STATUSES.includes(debt.status)) {
    throw AppError.conflict(
      'A dívida compensada precisa ser um valor a receber em aberto (não dinheiro de terceiro).',
      'FINANCE_THIRD_PARTY_COMPENSATED_DEBT_INVALID'
    );
  }
  if (String(debt.contractId || '') !== String(contractId)) {
    throw AppError.conflict(
      'A dívida compensada é de outro contrato — a caução só compensa dívida do mesmo contrato.',
      'FINANCE_THIRD_PARTY_COMPENSATED_DEBT_CONTRACT_MISMATCH'
    );
  }
  const remaining = await computeRemainingAmount(debt, transaction);
  if (toCents(amount) > toCents(remaining)) {
    throw AppError.conflict(
      `A compensação (${fromCents(toCents(amount))}) passa do saldo em aberto da dívida (${remaining}).`,
      'FINANCE_THIRD_PARTY_COMPENSATION_EXCEEDS_DEBT'
    );
  }
  void holderPersonId;
  return debt;
}

async function resolveThirdPartyRelease({ companyId, contractId, holderPersonId, originEntryId, amount }, transaction) {
  if (!originEntryId) {
    throw AppError.badRequest(
      'Informe de qual recebimento de caução esta devolução ou compensação sai — é isso que liga a saída ao contrato e ao titular corretos.',
      'FINANCE_THIRD_PARTY_ORIGIN_REQUIRED'
    );
  }
  // Lock no recebimento de origem: duas devoluções simultâneas da mesma caução não podem ler o
  // mesmo saldo e, somadas, devolver mais do que foi recebido.
  const origin = await entries.findInCompanyForUpdate(originEntryId, companyId, transaction);
  if (!origin) {
    throw AppError.notFound('Recebimento de origem não encontrado nesta empresa.', 'FINANCE_THIRD_PARTY_ORIGIN_NOT_FOUND');
  }
  if (!origin.isThirdPartyFunds || origin.nature !== 'RECEIVABLE' || origin.parentEntryId) {
    throw AppError.conflict(
      'O lançamento de origem não é um recebimento de dinheiro de terceiro (caução).',
      'FINANCE_THIRD_PARTY_ORIGIN_INVALID'
    );
  }
  if (!RECEIVED_STATUSES.includes(origin.status)) {
    throw AppError.conflict(
      'O recebimento de origem ainda não foi recebido — não há o que devolver ou compensar.',
      'FINANCE_THIRD_PARTY_ORIGIN_NOT_RECEIVED'
    );
  }
  if (!origin.contractId || !origin.thirdPartyHolderPersonId) {
    throw AppError.conflict(
      'O recebimento de origem não tem contrato e titular registrados — regularize o vínculo antes de devolver ou compensar.',
      'FINANCE_THIRD_PARTY_ORIGIN_UNTRACEABLE'
    );
  }
  if (contractId && String(contractId) !== String(origin.contractId)) {
    throw AppError.conflict(
      'O contrato da devolução/compensação é diferente do contrato em que a caução foi recebida.',
      'FINANCE_THIRD_PARTY_CONTRACT_MISMATCH'
    );
  }
  if (holderPersonId && String(holderPersonId) !== String(origin.thirdPartyHolderPersonId)) {
    throw AppError.conflict(
      'O titular da devolução/compensação é diferente do titular que entregou a caução.',
      'FINANCE_THIRD_PARTY_HOLDER_MISMATCH'
    );
  }
  const balance = await computeThirdPartyOriginBalance(origin, transaction);
  if (toCents(amount) > toCents(balance.available)) {
    throw AppError.conflict(
      `O valor (${fromCents(toCents(amount))}) é maior que o saldo ainda disponível da caução (${balance.available}).`,
      'FINANCE_THIRD_PARTY_RELEASE_EXCEEDS_BALANCE',
      { available: balance.available, received: balance.received, released: balance.released }
    );
  }
  return { origin, contractId: origin.contractId, holderPersonId: origin.thirdPartyHolderPersonId };
}

/**
 * Vínculos do dinheiro de terceiro na criação do lançamento (M4-16, F04, D2, D3 e repasse ao proprietário).
 * Devolve a marca normalizada, a referência, o contrato e o titular resolvidos, a caução de origem, o tipo de
 * saída e a dívida compensada — ou lança o mesmo erro de negócio de antes.
 */
async function resolveThirdPartyLinks(payload, normalizedNature, options, transaction) {
  const { companyId, bankAccountId, contractId, amount, isThirdPartyFunds, thirdPartyReference } = payload;
  const { thirdPartyOriginEntryId, thirdPartyHolderPersonId, thirdPartyReleaseType, thirdPartyCompensatedEntryId } = payload;

  // Caderno M5 JUR-013 ("Contrato pertence à empresa correta e não mistura documentos/financeiro"; verificação M5 linha 14): a FK
  // do Postgres ignora a RLS, então o contrato informado é conferido na empresa do lançamento antes de qualquer vínculo.
  if (contractId !== undefined && contractId !== null && contractId !== '') await assertContractOfCompany(contractId, companyId, transaction);

  // M4-16 — dinheiro de terceiro (caução, depósito de garantia, valores que só transitam pela
  // imobiliária) só pode ser marcado como tal se vier com a referência de a QUEM pertence.
  const normalizedThirdParty = isThirdPartyFunds === true || isThirdPartyFunds === 'true';
  const normalizedThirdPartyReference =
    thirdPartyReference === undefined || thirdPartyReference === null ? null : String(thirdPartyReference).trim();
  if (normalizedThirdParty && !normalizedThirdPartyReference) {
    throw AppError.badRequest(
      'Lançamento de dinheiro de terceiro exige uma referência preenchida (ex.: "Caução contrato X") — é o que identifica de quem é o dinheiro.',
      'FINANCE_THIRD_PARTY_REFERENCE_REQUIRED'
    );
  }

  // F04 — vínculo de origem, contrato e titular do dinheiro de terceiro.
  if (thirdPartyOriginEntryId && !(normalizedThirdParty && normalizedNature === 'PAYABLE')) {
    throw AppError.badRequest(
      'O recebimento de origem só se aplica a devolução ou compensação de dinheiro de terceiro (despesa marcada como dinheiro de terceiro).',
      'FINANCE_THIRD_PARTY_ORIGIN_NOT_APPLICABLE'
    );
  }
  /** @type {{ normalizedThirdParty: any, normalizedThirdPartyReference: any, resolvedContractId: any, resolvedHolderPersonId: any, thirdPartyRelease: any, resolvedReleaseType: string | null, compensatedDebt: any }} */
  const links = {
    normalizedThirdParty,
    normalizedThirdPartyReference,
    resolvedContractId: contractId || null,
    resolvedHolderPersonId: thirdPartyHolderPersonId || null,
    thirdPartyRelease: null,
    resolvedReleaseType: null,
    compensatedDebt: null,
  };
  if ((thirdPartyReleaseType || thirdPartyCompensatedEntryId) && !(normalizedThirdParty && normalizedNature === 'PAYABLE')) {
    throw AppError.badRequest(
      'O tipo de saída e a dívida compensada só se aplicam a devolução ou compensação de dinheiro de terceiro.',
      'FINANCE_THIRD_PARTY_ORIGIN_NOT_APPLICABLE'
    );
  }
  if (normalizedThirdParty && normalizedNature === 'PAYABLE' && options.ownerRepasseId) {
    // Repasse ao proprietário (19/10/2026): o dinheiro pago é do PROPRIETÁRIO (terceiro), não
    // despesa da empresa. Só o service de repasses passa `options.ownerRepasseId` (nunca vem do
    // body HTTP) — não há caução de origem: a origem é o próprio repasse aprovado.
    if (thirdPartyOriginEntryId || thirdPartyReleaseType || thirdPartyCompensatedEntryId) {
      throw AppError.badRequest('Pagamento de repasse não aceita vínculo de caução.', 'FINANCE_THIRD_PARTY_ORIGIN_NOT_APPLICABLE');
    }
    links.resolvedReleaseType = 'OWNER_REPASSE';
  } else if (normalizedThirdParty && normalizedNature === 'PAYABLE') {
    links.resolvedReleaseType = thirdPartyReleaseType ? String(thirdPartyReleaseType).toUpperCase() : 'RETURN';
    if (!THIRD_PARTY_RELEASE_TYPES.includes(links.resolvedReleaseType)) {
      throw AppError.badRequest(
        `O campo "thirdPartyReleaseType" deve ser um de: ${THIRD_PARTY_RELEASE_TYPES.join(', ')}.`,
        'FINANCE_ENTRY_VALIDATION'
      );
    }
    links.thirdPartyRelease = await resolveThirdPartyRelease(
      { companyId, contractId, holderPersonId: thirdPartyHolderPersonId, originEntryId: thirdPartyOriginEntryId, amount },
      transaction
    );
    links.resolvedContractId = links.thirdPartyRelease.contractId;
    links.resolvedHolderPersonId = links.thirdPartyRelease.holderPersonId;
    if (links.resolvedReleaseType === 'COMPENSATION') {
      if (bankAccountId) {
        throw AppError.badRequest(
          'Compensação não movimenta caixa — não informe conta bancária.',
          'FINANCE_THIRD_PARTY_COMPENSATION_NO_BANK_ACCOUNT'
        );
      }
      links.compensatedDebt = await resolveCompensatedDebt(
        { companyId, compensatedEntryId: thirdPartyCompensatedEntryId, contractId: links.resolvedContractId, holderPersonId: links.resolvedHolderPersonId, amount },
        transaction
      );
    } else if (thirdPartyCompensatedEntryId) {
      throw AppError.badRequest(
        'A dívida compensada só se aplica quando o tipo de saída é compensação.',
        'FINANCE_ENTRY_VALIDATION'
      );
    }
  } else if (normalizedThirdParty && normalizedNature === 'RECEIVABLE') {
    // D2 (revisão independente): recebimento de dinheiro de terceiro sem contrato e sem titular
    // era aceito e só travava na devolução. §13: toda movimentação exige vínculo.
    if (!links.resolvedContractId || !links.resolvedHolderPersonId) {
      throw AppError.badRequest(
        'Recebimento de caução exige o contrato e o titular. Informe os dois.',
        'FINANCE_THIRD_PARTY_LINK_REQUIRED'
      );
    }
    await assertThirdPartyHolderIsContractParty(links.resolvedHolderPersonId, links.resolvedContractId, transaction);
  } else if (normalizedThirdParty && links.resolvedHolderPersonId) {
    await assertThirdPartyHolderIsContractParty(links.resolvedHolderPersonId, links.resolvedContractId, transaction);
  } else if (!normalizedThirdParty && links.resolvedHolderPersonId) {
    throw AppError.badRequest(
      'O titular só se aplica a lançamento de dinheiro de terceiro.',
      'FINANCE_THIRD_PARTY_HOLDER_NOT_APPLICABLE'
    );
  }
  return links;
}

module.exports = {
  assertThirdPartyReleaseStillCovered,
  assertThirdPartyHolderIsContractParty,
  resolveCompensatedDebt,
  resolveThirdPartyRelease,
  resolveThirdPartyLinks,
};
