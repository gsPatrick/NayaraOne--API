'use strict';

/** Enumerações de domínio das fontes CONSTRUCTION e GUARANTEE (M9-D803): tipos de item (`source_kind`) e motivos de cancelamento. */
const KIND = Object.freeze({
  STAGE: 'STAGE', PROJECT: 'PROJECT', LEGAL_GUARANTEE: 'LEGAL_GUARANTEE', WARRANTY_CASE: 'WARRANTY_CASE', PROJECT_WARRANTY: 'PROJECT_WARRANTY',
});
const SOURCE_KINDS = Object.freeze(Object.values(KIND));
const CANCEL = Object.freeze({
  NO_DUE_DATE: 'NO_DUE_DATE', SOURCE_CANCELLED: 'SOURCE_CANCELLED', SOURCE_DELETED: 'SOURCE_DELETED', SOURCE_NOT_OPEN: 'SOURCE_NOT_OPEN',
});

module.exports = { KIND, SOURCE_KINDS, CANCEL };
