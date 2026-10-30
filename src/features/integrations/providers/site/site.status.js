'use strict';

/**
 * Status internos da página do site (M9-D259 3.1) e a ordem DENTRO de um mesmo envio: PENDING=0, PUBLISHED=1, UNPUBLISHED=1 (operações diferentes, cada uma no seu envio) e FAILED
 * fora da ordem (terminal, tratado à parte: aplica depois de PENDING, nunca depois de um status que já confirmou o envio).
 */
const STATUS = Object.freeze({ PENDING: 'PENDING', PUBLISHED: 'PUBLISHED', UNPUBLISHED: 'UNPUBLISHED', FAILED: 'FAILED' });
const RANK = Object.freeze({ PENDING: 0, PUBLISHED: 1, UNPUBLISHED: 1 });

/** Vocabulário do site-sandbox -> status interno (o adapter real de outro site traz o seu). */
const WIRE_TO_INTERNAL = Object.freeze({ pending: 'PENDING', live: 'PUBLISHED', removed: 'UNPUBLISHED', error: 'FAILED' });

module.exports = { STATUS, RANK, WIRE_TO_INTERNAL };
