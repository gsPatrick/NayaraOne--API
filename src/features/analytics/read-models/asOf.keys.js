'use strict';

/**
 * M9-D618 e M9-D619 — chave dos read models por EMPRESA e DATA-BASE (a data de calendário de São Paulo): o evento atualiza a linha de hoje e a agenda
 * (virada do dia às 00:05 e a cada 15 minutos) recalcula a linha de hoje, porque contagens de prazo, atraso e janela mudam sem nenhum evento.
 */
const { businessDateKey } = require('../../../utils/businessDate');
const clock = require('../metrics/clock');

/** aggregateKey: o worker sempre informa o relógio (nunca new Date() aqui). */
const asOfAggregateKey = (_event, { now }) => ({ as_of_date: businessDateKey(now) });

/** scheduled.keys / rebuild.keys. O rebuild não informa o relógio: usa o do BI (clock injetável). */
const asOfScheduledKeys = async ({ now }) => [{ as_of_date: businessDateKey(now || clock.now()) }];

module.exports = { asOfAggregateKey, asOfScheduledKeys };
