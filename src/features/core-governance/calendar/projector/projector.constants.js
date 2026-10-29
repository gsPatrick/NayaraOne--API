'use strict';

/** Estados do registro do inbox do projetor, efeitos de transição e motivos (M9-D802): enumerações de domínio, não códigos de erro. */
const INBOX = Object.freeze({ PROCESSED: 'PROCESSED', STALE: 'IGNORED_STALE', TRANSITION: 'IGNORED_TRANSITION', DEAD: 'DEAD' });
const EFFECT = Object.freeze({ APPLIED: 'APPLIED', NO_ITEM: 'NO_ITEM', NOT_ALLOWED: 'NOT_ALLOWED', TIE_LOST: 'TIE_LOST' });
const OUTCOME = Object.freeze({ APPLIED: 'APPLIED', STALE: 'STALE', UNCHANGED: 'UNCHANGED', IGNORED_TRANSITION: 'IGNORED_TRANSITION' });
const SKIP_MODULE_DISABLED = 'MODULE_DISABLED';

module.exports = { INBOX, EFFECT, OUTCOME, SKIP_MODULE_DISABLED };
