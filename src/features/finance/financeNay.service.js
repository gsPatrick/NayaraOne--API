'use strict';

const { sequelize, AiRun, CostCenter } = require('../../models');
const { getWeeklyHealthReport } = require('./financialHealthReport.service');
const { resolveAntifraudThresholds } = require('./financeAntifraud.service');
const { startOfBusinessDay } = require('../../utils/businessDate');

/**
 * NAY Financeira — Caderno Marco 4 §18 ("NAY Financeira"), Guia §13 ("Relatório semanal da NAY":
 * a NAY recebe o read model, não varre ledger bruto) e DoD "NAY sem permissão de execução
 * financeira" / FIN-014 ("NAY recomenda, não paga").
 *
 * Mesma decisão de engenharia da NAY Estoque/Obras: não há integração de LLM contratada nesta
 * fase; a NAY Financeira é RULE-BASED/determinística sobre o read model getWeeklyHealthReport e
 * sobre somas diretas de finance.financial_entries, sempre sob o RLS da empresa do contexto.
 *
 * Fronteira "recomenda, não paga", garantida por construção (e travada por
 * test/marco4.nayNoExecution.test.js): este arquivo só importa o read model, o resolvedor de
 * limiares (leitura do Motor de Regras), os modelos AiRun/CostCenter e o sequelize para SELECT.
 * A única escrita é a linha de auditoria da execução em "ai"."ai_runs". Não cria ledger, não
 * liquida, não altera favorecido, não fecha período.
 *
 * Toda resposta: cita as fontes internas (tabelas, read model, sourceSnapshotAt, versão da regra
 * FIN-005 usada), marca cada número como REALIZADO / PREVISTO / ESTIMADO e, se faltarem dados,
 * devolve conclusaoParcial=true com os motivos.
 */

const AGENT_NAME = 'NAY_FINANCEIRA';
const LIMITES =
  'A NAY Financeira só explica e sugere. Ela não cria ledger, não paga, não altera favorecido, não fecha período nem executa nenhuma ação: toda ação continua nas rotas humanas, com permissão, aprovação e MFA.';

const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function monthBounds(now) {
  // Limites do mês no fuso de São Paulo (mesma regra do fechamento).
  const spNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const y = spNow.getFullYear();
  const m = spNow.getMonth();
  const fmt = (yy, mm) => `${yy}-${String(mm + 1).padStart(2, '0')}`;
  const prevY = m === 0 ? y - 1 : y;
  const prevM = m === 0 ? 11 : m - 1;
  return { current: fmt(y, m), previous: fmt(prevY, prevM) };
}

async function realizedByMonth(transaction, months) {
  const rows = await sequelize.query(
    `SELECT to_char(settled_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') AS month, nature,
            COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::numeric AS total
       FROM finance.financial_entries
      WHERE status = 'SETTLED' AND is_third_party_funds = false AND nature IN ('PAYABLE','RECEIVABLE')
        AND settled_at IS NOT NULL
        AND to_char(settled_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') IN (:months)
      GROUP BY 1, 2`,
    { transaction, type: sequelize.QueryTypes.SELECT, replacements: { months } }
  );
  const out = {};
  for (const month of months) out[month] = { RECEIVABLE: 0, PAYABLE: 0 };
  for (const r of rows) out[r.month][r.nature] = round2(r.total);
  return out;
}

async function costCenterGrowth(transaction, months) {
  const rows = await sequelize.query(
    `SELECT cost_center_id, to_char(settled_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') AS month,
            COALESCE(SUM(amount), 0)::numeric AS total
       FROM finance.financial_entries
      WHERE status = 'SETTLED' AND is_third_party_funds = false AND nature = 'PAYABLE'
        AND cost_center_id IS NOT NULL AND settled_at IS NOT NULL
        AND to_char(settled_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') IN (:months)
      GROUP BY 1, 2`,
    { transaction, type: sequelize.QueryTypes.SELECT, replacements: { months } }
  );
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.cost_center_id)) by.set(r.cost_center_id, { atual: 0, anterior: 0 });
    by.get(r.cost_center_id)[r.month === months[0] ? 'atual' : 'anterior'] = round2(r.total);
  }
  const ids = [...by.keys()];
  const centers = ids.length ? await CostCenter.findAll({ where: { id: ids }, attributes: ['id', 'name'], transaction }) : [];
  const names = new Map(centers.map((c) => [c.id, c.name]));
  return [...by.entries()]
    .map(([id, v]) => ({ costCenterId: id, nome: names.get(id) || null, mesAtual: v.atual, mesAnterior: v.anterior, crescimento: round2(v.atual - v.anterior) }))
    .filter((x) => x.crescimento > 0)
    .sort((a, b) => b.crescimento - a.crescimento)
    .slice(0, 5);
}

async function openEntries(transaction, nature, startToday) {
  return sequelize.query(
    `SELECT id, description, amount::numeric AS amount, due_at, contract_id, cost_center_id
       FROM finance.financial_entries
      WHERE status = 'PENDING' AND is_third_party_funds = false AND nature = :nature
        ${nature === 'RECEIVABLE' ? 'AND due_at < :startToday' : ''}
      ORDER BY due_at ASC NULLS LAST
      LIMIT 200`,
    { transaction, type: sequelize.QueryTypes.SELECT, replacements: { nature, startToday } }
  );
}

async function dataCompleteness(transaction, currentMonth, report) {
  const motivos = [];
  const [accounts] = await sequelize.query(
    `SELECT COUNT(*)::int AS total FROM finance.bank_accounts WHERE deleted_at IS NULL AND status <> 'BLOCKED'`,
    { transaction, type: sequelize.QueryTypes.SELECT }
  );
  if (!accounts || accounts.total === 0) {
    motivos.push('Nenhuma conta bancária em uso cadastrada: o caixa disponível não tem extrato que o sustente.');
  } else {
    const withoutStatement = await sequelize.query(
      `SELECT ba.id FROM finance.bank_accounts ba
        WHERE ba.deleted_at IS NULL AND ba.status <> 'BLOCKED'
          AND NOT EXISTS (SELECT 1 FROM finance.bank_transactions bt
                           WHERE bt.bank_account_id = ba.id
                             AND to_char(bt.transaction_date AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') = :month)`,
      { transaction, type: sequelize.QueryTypes.SELECT, replacements: { month: currentMonth } }
    );
    if (withoutStatement.length > 0) {
      motivos.push(`${withoutStatement.length} conta(s) bancária(s) em uso sem extrato importado em ${currentMonth}.`);
    }
  }
  if (report.pendingReconciliations && report.pendingReconciliations.count > 0) {
    motivos.push(`${report.pendingReconciliations.count} transação(ões) de extrato ainda sem conciliação.`);
  }
  if (report.openHighRiskAnomalies === null) {
    motivos.push('Contagem de anomalias indisponível (empresa do contexto não informada).');
  }
  return motivos;
}

/**
 * getFinanceInsights — explicações + sugestões da NAY Financeira para a empresa do contexto.
 */
async function getFinanceInsights(tenant, actorUserId, transaction, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const startToday = startOfBusinessDay(now);
  const { current, previous } = monthBounds(now);

  const report = await getWeeklyHealthReport(transaction, { companyId: tenant.companyId, now });
  const thresholds = await resolveAntifraudThresholds(tenant, transaction);
  const realized = await realizedByMonth(transaction, [current, previous]);
  const growth = await costCenterGrowth(transaction, [current, previous]);
  const overdueReceivables = await openEntries(transaction, 'RECEIVABLE', startToday);
  const pendingPayables = await openEntries(transaction, 'PAYABLE', startToday);
  const motivosParcial = await dataCompleteness(transaction, current, report);

  const fonteReadModel = { readModel: 'finance.weeklyHealthReport', sourceSnapshotAt: report.generatedAt };
  const fonteEntries = { tabela: 'finance.financial_entries' };

  const netAtual = round2(realized[current].RECEIVABLE - realized[current].PAYABLE);
  const netAnterior = round2(realized[previous].RECEIVABLE - realized[previous].PAYABLE);

  const explicacoes = {
    fluxoCaixa: {
      texto: `Caixa livre de R$ ${report.freeCash.value.toFixed(2)} (extrato importado R$ ${report.freeCash.grossBankBalance.toFixed(2)} menos R$ ${report.freeCash.thirdPartyHeld.toFixed(2)} de terceiros retidos). Nos próximos 7 dias: R$ ${report.dueNextSevenDays.receivable.total.toFixed(2)} a receber e R$ ${report.dueNextSevenDays.payable.total.toFixed(2)} a pagar.`,
      numeros: [
        { indicador: 'caixaLivre', valor: report.freeCash.value, natureza: 'REALIZADO', fontes: [fonteReadModel, { tabela: 'finance.bank_transactions' }] },
        { indicador: 'dinheiroTerceirosRetido', valor: report.freeCash.thirdPartyHeld, natureza: 'REALIZADO', fontes: [fonteReadModel, fonteEntries] },
        { indicador: 'aReceber7d', valor: report.dueNextSevenDays.receivable.total, natureza: 'PREVISTO', fontes: [fonteReadModel] },
        { indicador: 'aPagar7d', valor: report.dueNextSevenDays.payable.total, natureza: 'PREVISTO', fontes: [fonteReadModel] },
        { indicador: 'saldoProjetado', valor: report.projectedNetBalance, natureza: 'PREVISTO', fontes: [fonteReadModel] },
      ],
    },
    variacoes: {
      texto: `Resultado realizado de ${current}: R$ ${netAtual.toFixed(2)}; de ${previous}: R$ ${netAnterior.toFixed(2)} (variação R$ ${round2(netAtual - netAnterior).toFixed(2)}).`,
      numeros: [
        { indicador: `recebido_${current}`, valor: realized[current].RECEIVABLE, natureza: 'REALIZADO', fontes: [fonteEntries] },
        { indicador: `pago_${current}`, valor: realized[current].PAYABLE, natureza: 'REALIZADO', fontes: [fonteEntries] },
        { indicador: `recebido_${previous}`, valor: realized[previous].RECEIVABLE, natureza: 'REALIZADO', fontes: [fonteEntries] },
        { indicador: `pago_${previous}`, valor: realized[previous].PAYABLE, natureza: 'REALIZADO', fontes: [fonteEntries] },
        { indicador: 'variacaoResultado', valor: round2(netAtual - netAnterior), natureza: 'REALIZADO', fontes: [fonteEntries] },
      ],
    },
    inadimplencia: {
      texto: `R$ ${report.overdue.receivable.total.toFixed(2)} a receber vencido em ${report.overdue.receivable.count} lançamento(s); índice de vencidos sobre o total elegível: ${(report.delinquencyRatio * 100).toFixed(2)}%.`,
      numeros: [
        { indicador: 'recebiveisVencidos', valor: report.overdue.receivable.total, natureza: 'REALIZADO', fontes: [fonteReadModel] },
        { indicador: 'indiceInadimplencia', valor: report.delinquencyRatio, natureza: 'REALIZADO', fontes: [fonteReadModel] },
      ],
    },
    necessidadeCapital: {
      texto:
        report.breathingNeed.value > 0
          ? `Estimativa de necessidade de R$ ${report.breathingNeed.value.toFixed(2)} para cobrir as saídas vencidas e da próxima semana (saídas obrigatórias − caixa livre − entradas prováveis).`
          : `Sem necessidade de capital estimada para a próxima semana (folga de R$ ${Math.abs(report.breathingNeed.value).toFixed(2)}).`,
      numeros: [{ indicador: 'necessidadeParaRespirar', valor: report.breathingNeed.value, natureza: 'ESTIMADO', fontes: [fonteReadModel] }],
    },
    anomalias: {
      texto: `${report.openHighRiskAnomalies ?? 'indisponível'} caso(s) de anomalia HIGH/CRITICAL em aberto.`,
      numeros: [{ indicador: 'anomaliasAltoRisco', valor: report.openHighRiskAnomalies, natureza: 'REALIZADO', fontes: [{ tabela: 'finance.anomaly_cases' }] }],
    },
  };

  // Dias de calendário em São Paulo entre o dia do vencimento e hoje.
  const daysBetween = (a, b) => Math.max(0, Math.round((b.getTime() - startOfBusinessDay(new Date(a)).getTime()) / 86400000));
  const overdueRanked = overdueReceivables
    .map((e) => {
      const dias = daysBetween(e.due_at, startToday);
      const valor = round2(e.amount);
      return { financialEntryId: e.id, descricao: e.description, valor, diasEmAtraso: dias, prioridade: round2(valor * Math.log2(dias + 2)), natureza: 'REALIZADO' };
    })
    .sort((a, b) => b.prioridade - a.prioridade);

  const sugestoes = {
    cobranca: overdueRanked
      .filter((x) => x.diasEmAtraso <= 30)
      .slice(0, 10)
      .map((x) => ({ ...x, razao: `Vencido há ${x.diasEmAtraso} dia(s); prioridade = valor × log2(dias+2).`, acaoSugerida: 'Cobrar pelo fluxo de cobrança (ação humana).' })),
    renegociacao: overdueRanked
      .filter((x) => x.diasEmAtraso > 30)
      .slice(0, 10)
      .map((x) => ({ ...x, razao: `Vencido há mais de 30 dias (${x.diasEmAtraso}).`, acaoSugerida: 'Avaliar acordo de cobrança versionado (ação humana).' })),
    reducaoCusto: growth.map((g) => ({ ...g, natureza: 'REALIZADO', razao: `Gasto liquidado cresceu R$ ${g.crescimento.toFixed(2)} de ${previous} para ${current}.` })),
    priorizacaoPagaveis: pendingPayables.slice(0, 10).map((e, i) => ({
      ordem: i + 1,
      financialEntryId: e.id,
      descricao: e.description,
      valor: round2(e.amount),
      vencimento: e.due_at,
      vencido: e.due_at ? new Date(e.due_at) < startToday : false,
      natureza: 'PREVISTO',
      razao: 'Ordem por vencimento (vencidos primeiro). Pagamento só pelo fluxo de intenção + aprovação + MFA.',
    })),
  };

  const fontes = {
    tabelas: ['finance.financial_entries', 'finance.bank_transactions', 'finance.reconciliations', 'finance.bank_accounts', 'finance.commissions', 'finance.owner_repasses', 'finance.anomaly_cases', 'finance.cost_centers'],
    readModel: 'finance.weeklyHealthReport',
    sourceSnapshotAt: report.generatedAt,
    regras: [{ codigo: 'FIN-005', ruleVersionId: thresholds.ruleVersionId || null, origem: thresholds.ruleVersionId ? 'Motor de Regras' : 'padrão (regra não publicada)' }],
  };

  const aiRun = await AiRun.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      userId: actorUserId || null,
      agentName: AGENT_NAME,
      inputSummary: `Explicação financeira e sugestões (${current} x ${previous}).`,
      toolCallsJson: { method: 'RULE_BASED', readModel: 'finance.weeklyHealthReport', months: [current, previous], ruleVersions: fontes.regras },
      outputSummary: `${sugestoes.cobranca.length + sugestoes.renegociacao.length + sugestoes.reducaoCusto.length + sugestoes.priorizacaoPagaveis.length} sugestão(ões); conclusão ${motivosParcial.length ? 'PARCIAL' : 'completa'}. Nenhuma ação executada (FIN-014).`,
      status: 'COMPLETED',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  return {
    agente: 'NAY Financeira',
    metodo: 'RULE_BASED',
    aiRunId: aiRun.id,
    geradoEm: now.toISOString(),
    sourceSnapshotAt: report.generatedAt,
    conclusaoParcial: motivosParcial.length > 0,
    motivosParcial,
    explicacoes,
    sugestoes,
    fontes,
    limites: LIMITES,
  };
}

module.exports = { getFinanceInsights, AGENT_NAME };
