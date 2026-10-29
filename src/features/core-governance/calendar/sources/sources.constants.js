'use strict';

/** Enumerações de domínio das fontes CONSTRUCTION e GUARANTEE (M9-D803): tipos de item (`source_kind`) e motivos de cancelamento. */
const KIND = Object.freeze({
  STAGE: 'STAGE', PROJECT: 'PROJECT', LEGAL_GUARANTEE: 'LEGAL_GUARANTEE', WARRANTY_CASE: 'WARRANTY_CASE', PROJECT_WARRANTY: 'PROJECT_WARRANTY',
});
// Tipos de item das renovações (RENEWAL, M9-D802): ficam FORA de SOURCE_KINDS de propósito — a varredura de M9-D803 só cuida de obras e garantias.
const RENEWAL_KIND = Object.freeze({ INSURANCE: 'INSURANCE_RENEWAL', CONTRACT: 'CONTRACT_RENEWAL' });
const SOURCE = Object.freeze({ CRM_TASK: 'CRM_TASK', LEGAL_DEADLINE: 'LEGAL_DEADLINE' });
const SOURCE_KINDS = Object.freeze(Object.values(KIND));
const CANCEL = Object.freeze({
  NO_DUE_DATE: 'NO_DUE_DATE', SOURCE_CANCELLED: 'SOURCE_CANCELLED', SOURCE_DELETED: 'SOURCE_DELETED', SOURCE_NOT_OPEN: 'SOURCE_NOT_OPEN',
});

module.exports = { KIND, SOURCE_KINDS, CANCEL, RENEWAL_KIND, SOURCE };
