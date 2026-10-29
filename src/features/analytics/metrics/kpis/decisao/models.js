'use strict';

// M9-D709 — nome do read model lido pelos KPIs da fila de decisão. Só o nome: o SQL monta o schema pelo nome (a varredura da M9-D700 só deixa citar `rm_...` com o schema na camada read-models).
const MODELS = Object.freeze({ queue: 'rm_decision_queue' });

module.exports = { MODELS };
