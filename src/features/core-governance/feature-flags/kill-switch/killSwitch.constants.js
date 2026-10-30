'use strict';

/** Constantes do kill switch crítico testado periodicamente (M9-D872). Listas fechadas do livro/da demanda; o que varia por empresa é parâmetro (flags.settings.js). */
const DRILL_ENVIRONMENTS = Object.freeze(['HOMOLOG', 'DEV']);
/** O PASS de um desses ambientes (e da mesma versão do probe) vale para o switch de qualquer ambiente, PROD inclusive. */
const PASS_ENVIRONMENTS = DRILL_ENVIRONMENTS;
const VERIFICATION = Object.freeze({ PENDING: 'PENDING', VERIFIED: 'VERIFIED', UNVERIFIED: 'UNVERIFIED' });
const RESULTS = Object.freeze({ RUNNING: 'RUNNING', PASS: 'PASS', FAIL: 'FAIL' });
const AUDIT = Object.freeze({ drill: 'governance.kill_switch.drill', refused: 'governance.kill_switch.drill_refused', entity: 'governance.feature_flag' });
const ALERT_TYPES = Object.freeze({ stale: 'KILL_SWITCH_STALE', failed: 'KILL_SWITCH_FAILED', refused: 'KILL_DRILL_REFUSED' });
const ACTIONS = Object.freeze({ activate: 'kill_switch.activate', restore: 'kill_switch.restore' });
const STALE_REASONS = Object.freeze({ never: 'NEVER_PASSED', old: 'PASS_TOO_OLD', version: 'PROBE_VERSION_CHANGED', probeMissing: 'PROBE_NOT_REGISTERED' });

module.exports = { DRILL_ENVIRONMENTS, PASS_ENVIRONMENTS, VERIFICATION, RESULTS, AUDIT, ALERT_TYPES, ACTIONS, STALE_REASONS };
