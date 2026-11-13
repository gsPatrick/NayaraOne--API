'use strict';

const V = require('../../../shared/validation/requestSchema');

/**
 * Consulta de `GET /ai/release-gates` (rodada 8 da verificação do Marco 9, DI-M9R-24): `status[]=A&status[]=B` chegava ao SQL como lista no lugar
 * de um valor (42804, 500). `item` e `status` são um texto só.
 */
const LISTAR = V.objetoAberto({ item: V.textoDaConsulta({ max: 80 }), status: V.textoDaConsulta({ max: 20 }) });

module.exports = { validarListagemDeAprovacoes: V.validarEntrada({ query: LISTAR }, 'AI_GATE_INVALID'), ESQUEMAS: { LISTAR } };
