'use strict';

// Massa de teste do painel Financeiro (M9-D626): lançamentos do Financeiro na empresa A gravados por superusuário, SEM lançamento nos dias limite das janelas (o relatório semanal
// conta o dia N+1 como parte da janela de N dias; o KPI do livro termina em hoje+N-1, ver DI-D626-4), com o read model refeito e os KPIs calculados de verdade.
// Hoje é 28/10/2026 (São Paulo). Banco descartável.
const envKit = require('./finKpiEnv');
const ledger = require('./m9d615Ledger');

const { dayAt } = envKit;
const MASS = [
  { nature: 'PAYABLE', amount: '10000.00', due: dayAt(0) }, { nature: 'PAYABLE', amount: '5000.00', due: dayAt(5) }, { nature: 'PAYABLE', amount: '3000.00', due: dayAt(20) },
  { nature: 'PAYABLE', amount: '18500.00', due: dayAt(40) }, { nature: 'PAYABLE', amount: '999.00', due: dayAt(75) },
  { nature: 'RECEIVABLE', amount: '18000.00', due: dayAt(3) }, { nature: 'RECEIVABLE', amount: '47000.00', due: dayAt(20) }, { nature: 'RECEIVABLE', amount: '47500.00', due: dayAt(45) },
  { nature: 'PAYABLE', amount: '777.00', due: dayAt(-1) }, { nature: 'RECEIVABLE', amount: '2500.00', due: dayAt(-3) }, { nature: 'RECEIVABLE', amount: '4000.00', due: dayAt(-40) },
  { nature: 'RECEIVABLE', amount: '54000.00', due: dayAt(2), third: true }, // aluguel a repassar em aberto: terceiros, fora dos recebíveis próprios
  { nature: 'RECEIVABLE', amount: '1200.00', status: 'SETTLED', settled: dayAt(-2), third: true, due: dayAt(-2) }, // caução recebida e retida
  { nature: 'PAYABLE', amount: '200.00', status: 'SETTLED', settled: dayAt(-1), third: true, due: dayAt(-1) }, // parte da caução já devolvida
  { nature: 'PAYABLE', amount: '444.00', status: 'REVERSED', due: dayAt(2) }, { nature: 'RECEIVABLE', amount: '444.00', status: 'CANCELLED', due: dayAt(2) },
];

/** Grava a massa na empresa `t`, refaz o read model e calcula os KPIs financeiros da data-base. `env.created` guarda os ids para a limpeza. */
async function seedMass(env, t) {
  if (!env.created) env.created = [];
  for (const row of MASS) await ledger.entry(env, t, row);
  await envKit.refresh(t);
  await envKit.kpis(t);
}

const cleanupMass = (env) => ledger.cleanup(env);

module.exports = { MASS, seedMass, cleanupMass };
