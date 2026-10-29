'use strict';

// Leituras de referência dos testes dos agentes NAY (M9-D035 e M9-D036): o mesmo read model que o agente usa, lido por fora ANTES e DEPOIS
// de os dados do teste serem criados. Assim a prova é "a resposta mostra o valor do read model" e "os meus dados mudaram o read model em
// exatamente tanto", e continua valendo num banco que já tem dados de outros testes (o CI roda todos os arquivos no mesmo banco).
const { getWeeklyHealthReport } = require('../../../src/features/finance/financialHealthReport.service');
const { getExpiringContracts } = require('../../../src/features/legal/expiringContracts.service');
const { getPipelineSummary } = require('../../../src/features/crm/pipelineSummary.service');

/** Dinheiro em pt-BR como o servidor escreve: "R$ 12.000,00". */
const brl = (n) => `R$ ${Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (n) => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
const pct = (r) => `${(Math.round(Number(r) * 10000) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;

const round2 = (v) => Math.round(Number(v) * 100) / 100;
const bandas = (tx) => getExpiringContracts(tx, { bands: [30, 60, 90], detail: false });
const financeiro = (tx) => getWeeklyHealthReport(tx);
const funil = (tx) => getPipelineSummary(tx);

module.exports = { brl, num, pct, round2, bandas, financeiro, funil };
