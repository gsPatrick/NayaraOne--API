'use strict';

/**
 * M9-D628 — peças comuns dos read models de Tecnologia e IA: janela de dias de São Paulo, leitura SQL e a definição de um read model cujo AGREGADO é a empresa
 * inteira (várias linhas por dimensão, todas recalculadas juntas, estado e nunca delta). Sem evento próprio de chave: o evento (quando há) e a agenda
 * apontam para a mesma chave vazia, e o rebuild reconstrói tudo da fonte. Nenhum conteúdo de prompt, resposta, e-mail, IP ou segredo entra: só contagens, custos e pontuações.
 */
const { sequelize } = require('../../../../models');
const { businessDateKey, BUSINESS_TIMEZONE } = require('../../../../utils/businessDate');
const { registerReadModel } = require('../readModel.registry');
const { companyAggregateKey, companyKeys } = require('../companyAggregate.keys');
const { shiftDay } = require('../aggregateModel.sql');
const { readTechParams } = require('../tecnologia.settings');

const select = async (sql, replacements, transaction) => (await sequelize.query(sql, { replacements: { tz: BUSINESS_TIMEZONE, ...replacements }, transaction }))[0];

/** { today, from } em datas de calendário de São Paulo: `historyDays` dias terminando hoje. */
function windowOf(now, historyDays) {
  const today = businessDateKey(now);
  return { today, from: shiftDay(today, -(historyDays - 1)) };
}

/** Primeiro dia do mês (AAAA-MM-01) da data dada: custo e orçamento são mensais, então a janela cobre meses inteiros. */
const monthStart = (day) => `${day.slice(0, 7)}-01`;

/**
 * Registra um read model da empresa inteira. `build({ companyId, groupId, now, params, window, transaction })` devolve as linhas { key, fields }; `events` são
 * os eventos do outbox que o recalculam (vazio = só agenda e rebuild); `scheduled` liga o recálculo pela agenda (padrão: sim, porque todos dependem do relógio ou de fonte sem evento).
 */
function defineCompanyWideModel({ name, keyColumns, events = [], build, version = 1, reconcileAtRefresh = false }) {
  async function recompute({ companyId, groupId, now, transaction }) {
    const params = await readTechParams({ companyId, groupId }, transaction);
    const rows = await build({ companyId, groupId, now, params, window: windowOf(now, params.historyDays), transaction });
    return { rows, sourceSnapshotAt: now };
  }
  return registerReadModel({
    name, version, keyColumns, aggregateColumns: [], eventTypes: [...events], reconcileAtRefresh, aggregateKey: companyAggregateKey, recompute,
    scheduled: { keys: companyKeys }, rebuild: { keys: companyKeys },
  });
}

/** Linha { key, fields } a partir de um registro do SELECT: as colunas da chave vão para `key`, as demais para `fields`. */
const toRow = (keyColumns) => (record) => {
  const key = {}; const fields = {};
  for (const [column, value] of Object.entries(record)) (keyColumns.includes(column) ? key : fields)[column] = value;
  return { key, fields };
};

module.exports = { select, windowOf, monthStart, defineCompanyWideModel, toRow, BUSINESS_TIMEZONE };
