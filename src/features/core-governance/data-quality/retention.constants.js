'use strict';

/** Vocabulário fechado da retenção (M9-D911 §3.1). Os mesmos valores estão nos CHECKs da migration 852. */
const TRIGGERS = Object.freeze(['CONTRACT_END', 'TRANSACTION_DATE', 'PERSON_INACTIVE_SINCE', 'CASE_CLOSED', 'UPLOAD_DATE', 'LEAD_LAST_CONTACT', 'FISCAL_PERIOD_END']);
const DISPOSITIONS = Object.freeze({ DELETE: 'DELETE', ANONYMIZE: 'ANONYMIZE', ARCHIVE: 'ARCHIVE', REVIEW: 'REVIEW' });
const EXCEPTIONS = Object.freeze(['LEGAL_HOLD', 'ONGOING_LITIGATION', 'TAX_AUDIT', 'OPEN_OBLIGATION', 'CUSTOMER_OBJECTION']);

/** Bases legais: código fixo -> texto padrão (o livro lista os códigos; `LGPD_ART11_*` serve aos dados sensíveis). */
const LEGAL_BASES = Object.freeze({
  LGPD_ART7_II_OBRIGACAO_LEGAL: 'LGPD, art. 7º, II: cumprimento de obrigação legal ou regulatória pelo controlador.',
  LGPD_ART7_V_CONTRATO: 'LGPD, art. 7º, V: execução de contrato ou de procedimentos preliminares a pedido do titular.',
  LGPD_ART7_VI_EXERCICIO_DIREITOS: 'LGPD, art. 7º, VI: exercício regular de direitos em processo judicial, administrativo ou arbitral.',
  LGPD_ART7_IX_LEGITIMO_INTERESSE: 'LGPD, art. 7º, IX: atendimento dos interesses legítimos do controlador ou de terceiro.',
  LGPD_ART7_I_CONSENTIMENTO: 'LGPD, art. 7º, I: mediante o fornecimento de consentimento pelo titular.',
});
const ART11 = /^LGPD_ART11_[A-Z0-9_]{1,40}$/;

const RUN_STATUS = Object.freeze({ DRY_DONE: 'DRY_DONE', APPLYING: 'APPLYING', APPLIED: 'APPLIED', FAILED: 'FAILED' });
const ITEM_STATE = Object.freeze({
  PENDING: 'PENDING', DONE: 'DONE', HOLD: 'SKIPPED_HOLD', EXCEPTION: 'SKIPPED_EXCEPTION', NOT_ELIGIBLE: 'SKIPPED_NOT_ELIGIBLE', POLICY_CHANGED: 'SKIPPED_POLICY_CHANGED', GONE: 'SKIPPED_GONE',
});

const PERMISSION = 'governance:retention:manage';
const READ_PERMISSIONS = Object.freeze([PERMISSION, 'governance:data-quality:read']);
const TIME_ZONE = 'America/Sao_Paulo';
const REVIEW_DEFAULT = 'REVIEW_DEFAULT';
const HOLD_ENTITY_INTEGRATION = 'INTEGRATION';

module.exports = {
  TRIGGERS, DISPOSITIONS, EXCEPTIONS, LEGAL_BASES, ART11, RUN_STATUS, ITEM_STATE, PERMISSION, READ_PERMISSIONS, TIME_ZONE, REVIEW_DEFAULT, HOLD_ENTITY_INTEGRATION,
};
