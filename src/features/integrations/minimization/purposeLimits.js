'use strict';

/**
 * Máximo de classificação que cada família aceita (M9-D219 3.1). É o TETO do livro: o administrador só consegue
 * ABAIXAR (integration.minimizacao.max_classificacao.<família>), nunca subir. O livro não cobre INSURANCE, FISCAL, STORAGE e
 * IDENTITY (DI-D219-1): os três primeiros precisam de dado pessoal do segurado, do tomador e do usuário (PERSONAL); STORAGE
 * recebe objetos, não campos de pessoa, e fica em INTERNAL.
 */
const BOOK_CEILING = Object.freeze({
  PORTAL: 'PUBLIC', SITE: 'PUBLIC', SOCIAL: 'PUBLIC',
  MESSAGING: 'PERSONAL', EMAIL: 'PERSONAL',
  BANK: 'PERSONAL', SIGNATURE: 'PERSONAL', FINANCING: 'SENSITIVE',
  ANALYTICS: 'PUBLIC', AI: 'PUBLIC',
  INSURANCE: 'PERSONAL', FISCAL: 'PERSONAL', IDENTITY: 'PERSONAL', STORAGE: 'INTERNAL',
});

/** Famílias em que dado ACIMA do máximo só passa se o campo estiver marcado como pseudonimizado (ANALYTICS e AI). */
const PSEUDONYMIZED_DOMAINS = Object.freeze(['ANALYTICS', 'AI']);
/** Classificação máxima de um campo pseudonimizado nessas famílias. */
const PSEUDONYMIZED_CEILING = 'PERSONAL';
/** Famílias em que campo SENSITIVE só sai se a pessoa consentiu (a promotora exige e o consentimento existe). */
const CONSENT_FOR_SENSITIVE_DOMAINS = Object.freeze(['FINANCING']);

const PURPOSE_RE = /^[A-Z][A-Z0-9_]{2,47}$/;

module.exports = { BOOK_CEILING, PSEUDONYMIZED_DOMAINS, PSEUDONYMIZED_CEILING, CONSENT_FOR_SENSITIVE_DOMAINS, PURPOSE_RE };
