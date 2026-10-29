'use strict';

/**
 * M9-D681 — peças comuns das fórmulas dos KPIs de IA: chave de dimensão sem o separador ":" (o código do agente, do modelo e da ferramenta entram na chave), soma exata dos campos
 * de uma lista e a agregação por chave. Aritmética sempre pelo utilitário decimal (money.js).
 */
const money = require('./money');
const { byText } = require('./_legalCorKpi');

/** O ":" separa as partes da chave de dimensão (grupo:id:medida): dentro de um código vira "_". */
const safe = (id) => String(id).replace(/:/g, '_');

/** Soma exata (texto decimal) do campo de cada linha; ausente conta zero. */
const total = (rows, pick) => money.sum(rows.map((r) => pick(r) ?? 0));

/** Códigos distintos em ordem alfabética estável. */
const distinct = (list) => [...new Set(list)].sort(byText);

module.exports = { safe, total, distinct };
