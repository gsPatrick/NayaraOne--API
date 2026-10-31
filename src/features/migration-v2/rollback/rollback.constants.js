'use strict';

/** Constantes do plano para operações externas irreversíveis (M9-D907). */
const REVERSIBILITY = Object.freeze({ REVERSIBLE: 'REVERSIBLE', COMPENSABLE: 'COMPENSABLE', IRREVERSIBLE: 'IRREVERSIBLE' });
const NEEDS_COMPENSATION = Object.freeze([REVERSIBILITY.COMPENSABLE, REVERSIBILITY.IRREVERSIBLE]);
const STATES = Object.freeze({ PENDING: 'PENDING_COMPENSATION', COMPENSATED: 'COMPENSATED' });
const DECISIONS = Object.freeze({ GO: 'GO', NO_GO: 'NO_GO' });
const BLOCKER = Object.freeze({ COMPENSATION_REQUIRED: 'GOV_ROLLBACK_COMPENSATION_REQUIRED', PENDING: 'GOV_ROLLBACK_PENDING' });
const ACTIVITY_ROLLBACK = 'ROLLBACK_EXECUTION'; // atividade do RACI (M9-D902) cujo A responde pelo rollback
const AUDIT = Object.freeze({ TYPE: 'migration.external_op_type.saved', RESOLVED: 'migration.rollback_item.resolved', DECISION: 'migration.cutover.decided' });
const AUDIT_ENTITY = Object.freeze({ TYPE: 'MigrationExternalOpType', ITEM: 'MigrationRollbackItem', DECISION: 'MigrationCutoverDecision' });
/** Envios do `integration.dispatches` que nunca saíram: não geram o que compensar. */
const NEVER_SENT = Object.freeze(['CANCELLED', 'FAILED', 'DEAD_LETTER']);
const FIELD_MAX = Object.freeze({ code: 64, module: 40, owner: 120, entity: 64, text: 2000, note: 1000, ref: 128 });

module.exports = { REVERSIBILITY, NEEDS_COMPENSATION, STATES, DECISIONS, BLOCKER, ACTIVITY_ROLLBACK, AUDIT, AUDIT_ENTITY, NEVER_SENT, FIELD_MAX };
