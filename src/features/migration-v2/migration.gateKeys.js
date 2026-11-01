'use strict';

const { KEYS } = require('./dryrun/dry.settings');
const { STAGES_KEY, REQUIRE_COMPARISON_KEY } = require('./canary/canary.settings');

/**
 * Parâmetros que decidem se o corte pode acontecer (M9-D908 reabertura R3-L3): a validade, o volume mínimo e a exigência de commit igual do relatório DRY3, a exigência de
 * comparação paralela e as etapas do canary. Afrouxá-los sozinho com settings:update ou flags:manage deixaria o GO aceitar relatório velho, de outro commit ou pequeno; por isso
 * exigem também governance:migration:admin, a mesma permissão de decidir o corte e de alterar a RACI.
 */
const MIGRATION_ADMIN_PERMISSION = 'governance:migration:admin';
const GATE_KEYS = Object.freeze([KEYS.VALIDITY_HOURS, KEYS.MIN_VOLUME, KEYS.SAME_COMMIT, REQUIRE_COMPARISON_KEY, STAGES_KEY]);

// R4-L1: toda chave `migracao.` do dicionário (relógio e NTP, escopo do legado, dado pessoal em claro no ensaio, retenção do payload, tetos de execução, expiração de replay) é parâmetro de segurança do corte.
const isMigrationGateKey = (key) => GATE_KEYS.includes(String(key)) || String(key).startsWith('migracao.');

module.exports = { MIGRATION_ADMIN_PERMISSION, GATE_KEYS, isMigrationGateKey };
