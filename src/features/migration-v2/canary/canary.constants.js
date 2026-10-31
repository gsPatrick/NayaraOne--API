'use strict';

const { SECTOR_CODES } = require('../../core-governance/bcp/bcp.constants');

/** Constantes do canary por setor (M9-D904). O estado de cada setor vive só na entrada do registro de flags (M9-D870); não há tabela própria. */
const ACTION_ROLLBACK = 'migration.canary.rollback'; // linha 15 do inventário de ações destrutivas (M9-D852)
const ACTIVITY = 'SECTOR_ACTIVATION'; // atividade do RACI de cutover (M9-D902) cujo A é o responsável pela flag do setor
const AUDIT = Object.freeze({ ADVANCED: 'migration.canary.advanced', ROLLED_BACK: 'migration.canary.rolled_back' });
const AUDIT_ENTITY = 'MigrationCanary';
const REASON_MAX = 500;
const RUN_PERMISSION = 'governance:migration:run';
const FLAGS_PERMISSION = 'governance:flags:manage';

/** `migracao.setor.<setor>.novo_sistema` (minúsculas: o registro de flags só aceita chaves em minúsculas). O escopo é SECTOR e a referência é o código do setor. */
const FLAG_KEY_PREFIX = 'migracao.setor.';
const FLAG_KEY_SUFFIX = '.novo_sistema';
const FLAG_OWNER = 'migration.canary'; // dono das chaves protegidas do registro de flags (flags.protected): só o canary as escreve
const flagKey = (sector) => `${FLAG_KEY_PREFIX}${sector.toLowerCase()}${FLAG_KEY_SUFFIX}`;
/** Só a flag de canary de um setor (prefixo, um único segmento de setor e o sufixo); parâmetros vizinhos, como `.entidades`, não são flag de canary (R3-L2). */
const isCanaryFlagKey = (key) => typeof key === 'string' && key.startsWith(FLAG_KEY_PREFIX) && key.endsWith(FLAG_KEY_SUFFIX) && !key.slice(FLAG_KEY_PREFIX.length, -FLAG_KEY_SUFFIX.length).includes('.') && key.length > FLAG_KEY_PREFIX.length + FLAG_KEY_SUFFIX.length;
const flagDescription = (sector) => `Percentual de usuários do setor ${sector} que operam no sistema novo (canary da migração).`;
const isSector = (value) => typeof value === 'string' && SECTOR_CODES.includes(value);

module.exports = { SECTOR_CODES, ACTION_ROLLBACK, ACTIVITY, AUDIT, AUDIT_ENTITY, REASON_MAX, RUN_PERMISSION, FLAGS_PERMISSION, FLAG_KEY_PREFIX, FLAG_KEY_SUFFIX, FLAG_OWNER, flagKey, isCanaryFlagKey, flagDescription, isSector };
