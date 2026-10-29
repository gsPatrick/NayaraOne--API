'use strict';

/** Domínios que sempre exigem workflow humano (AI-007): financeiro, jurídico, bancário, permissões e publicação crítica. */
const SENSITIVE_DOMAINS = Object.freeze(['FINANCIAL', 'LEGAL', 'BANKING', 'PERMISSION', 'PUBLICATION']);

const isSensitiveDomain = (def) => SENSITIVE_DOMAINS.includes(def && def.domain);

module.exports = { SENSITIVE_DOMAINS, isSensitiveDomain };
