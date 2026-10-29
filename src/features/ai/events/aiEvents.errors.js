'use strict';

const AppError = require('../../../utils/AppError');

/** Evento mal formado, desconhecido ou com dado pessoal: 500, e a operação inteira é desfeita (o evento nasce na transação do dado). */
const incomplete = (details) => new AppError('Erro interno ao registrar o evento; a operação foi desfeita.', 500, 'AI_OUTBOX_EVENT_INCOMPLETE', details);

module.exports = { incomplete };
