'use strict';

/** Enumerações da alteração em massa (M9-D808). São valores de domínio, não códigos de erro. */
const LOT_STATUS = Object.freeze({ DONE: 'DONE', FAILED: 'FAILED' });
const RECORD_TYPES = Object.freeze({ PERSON: 'PERSON', PROPERTY: 'PROPERTY', BANK_ACCOUNT: 'BANK_ACCOUNT', REVIEW_ITEM: 'REVIEW_ITEM' });
const PERMISSION = 'governance:data-quality:bulk';

/** Ações gravadas na auditoria (audit.audit_log.action). */
const AUDIT = Object.freeze({
  ITEM: 'governance.bulk_change.item', EXECUTED: 'governance.bulk_change.executed', BLOCKED: 'governance.bulk_change.blocked', FAILED: 'governance.bulk_change.failed',
});

/** Entidade da auditoria de cada tipo de registro alterado. */
const AUDIT_ENTITY = Object.freeze({ PERSON: 'Person', PROPERTY: 'Property', BANK_ACCOUNT: 'BankAccount', REVIEW_ITEM: 'ReviewQueueItem' });

module.exports = { LOT_STATUS, RECORD_TYPES, PERMISSION, AUDIT, AUDIT_ENTITY };
