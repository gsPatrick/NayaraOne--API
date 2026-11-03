'use strict';

/**
 * Resposta HTTP padronizada da API — mantém formato consistente entre todas
 * as features (routes → controller → service).
 */
// BUG REAL CORRIGIDO ("ciclos até secar", Ciclo 6, Frente B, 09/10/2026): `success` só
// desestruturava statusCode/data/meta/message — qualquer controller que chamasse
// `success(res, { data, pagination })` tinha o bloco `pagination` descartado silenciosamente
// (nunca chegava no corpo da resposta HTTP), mesmo já existindo 3 controllers nesse padrão
// (listProjects, listDailyReports, listMaintenanceCases) pensando que o cliente HTTP recebia
// paginação real.
function success(res, { statusCode = 200, data = null, meta = undefined, pagination = undefined, message = undefined } = {}) {
  const body = { success: true, data };
  if (meta !== undefined) body.meta = meta;
  if (pagination !== undefined) body.pagination = pagination;
  if (message !== undefined) body.message = message;
  return res.status(statusCode).json(body);
}

function failure(res, { statusCode = 500, code = 'INTERNAL_ERROR', message = 'Erro interno.', details = undefined } = {}) {
  const body = { success: false, error: { code, message } };
  if (details !== undefined) body.error.details = details;
  return res.status(statusCode).json(body);
}

module.exports = { success, failure };
