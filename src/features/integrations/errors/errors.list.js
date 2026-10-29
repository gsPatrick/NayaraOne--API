'use strict';

const { Op, literal, where: sqlWhere, fn, col } = require('sequelize');
const { IntegrationError } = require('../../../models');
const { readErrorParams } = require('./errors.params');
const { serializeError } = require('./errors.serialize');
const { encodeCursor } = require('../admin/admin.query');
const { brtDeep } = require('../admin/admin.format');

const LIMITE_PADRAO = 50;
// O instante do cursor é o do banco, cortado em milissegundos: é a mesma chave da ordenação, então a próxima página nunca repete nem pula linha.
const CURSOR_TS = literal(`to_char(date_trunc('milliseconds', "created_at") AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
const CHAVE_TEMPO = fn('date_trunc', 'milliseconds', col('created_at'));

/**
 * Lista os erros da empresa (RLS isola as demais), do mais novo para o mais antigo, paginada por cursor (M9-D249).
 * `query` já validado por parseErrorsQuery: status, source, provider, connectionId, limit (1 a 200, padrão 50) e cursor decodificado.
 * `nextCursor` é null na última página. `retentionDays` mostra quanto tempo o erro fica guardado.
 */
async function listErrors(ctx, query = {}, transaction) {
  const filtros = { companyId: ctx.companyId };
  if (query.status) filtros.status = query.status;
  if (query.source) filtros.source = query.source;
  if (query.provider || query.providerCode) filtros.providerCode = query.provider || query.providerCode;
  if (query.connectionId) filtros.connectionId = query.connectionId;
  const limit = Number.isInteger(query.limit) && query.limit >= 1 ? query.limit : LIMITE_PADRAO;
  const e = [filtros];
  if (query.cursor) {
    e.push({ [Op.or]: [
      sqlWhere(CHAVE_TEMPO, Op.lt, query.cursor.createdAt),
      { [Op.and]: [sqlWhere(CHAVE_TEMPO, Op.eq, query.cursor.createdAt), { id: { [Op.lt]: query.cursor.id } }] },
    ] });
  }
  const [rows, params] = await Promise.all([
    IntegrationError.findAll({
      where: { [Op.and]: e },
      attributes: { include: [[CURSOR_TS, 'cursor_ts']] },
      order: [[CHAVE_TEMPO, 'DESC'], ['id', 'DESC']],
      limit: limit + 1,
      transaction,
    }),
    readErrorParams(ctx, transaction),
  ]);
  const pagina = rows.slice(0, limit);
  const ultima = pagina[pagina.length - 1];
  const nextCursor = rows.length > limit && ultima ? encodeCursor(ultima.get('cursor_ts'), ultima.id) : null;
  return brtDeep({ items: pagina.map(serializeError), retentionDays: params.retentionDays, nextCursor });
}

module.exports = { listErrors };
