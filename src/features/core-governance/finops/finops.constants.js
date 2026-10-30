'use strict';

/** Constantes do ledger de custo técnico (M9-D860). Listas fechadas do livro. */
const ENVIRONMENTS = Object.freeze(['PROD', 'HOMOLOG', 'DEV']);
const CATEGORIES = Object.freeze(['CLOUD_SERVICE', 'PROVIDER', 'AI', 'STORAGE', 'EGRESS', 'MESSAGING']);
const COST_KINDS = Object.freeze(['ESTIMATED', 'BILLED']);
const LINE_TYPES = Object.freeze(['CHARGE', 'CREDIT']);
const PLATFORM_DOMAIN = 'PLATFORM';
const SHARED_COMPANY_KEY = '00000000-0000-0000-0000-000000000000';
const COLLECTORS = Object.freeze(['ai', 'messaging', 'storage', 'egress', 'billing']);
const HOUR_MS = 3600000;
/** Escala dos centavos fracionários dos acúmulos: centavos x 1.000.000. */
const SCALE = 1000000n;

module.exports = { ENVIRONMENTS, CATEGORIES, COST_KINDS, LINE_TYPES, PLATFORM_DOMAIN, SHARED_COMPANY_KEY, COLLECTORS, HOUR_MS, SCALE };
