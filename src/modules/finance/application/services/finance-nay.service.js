'use strict';

const { sequelize } = require('../../../../models');
const { recordRuleRun } = require('../../../../features/ai/orchestrator/runs');
const { resolveAntifraudThresholds } = require('./finance-antifraud.service');
const { startOfBusinessDay, businessDateKey } = require('../../../../utils/businessDate');
const readModel = require('../../infrastructure/repositories/finance-health-read-model.repository');
const { buildExplanations, buildSectorGrowth } = require('./finance-nay-sections');
const { toCents } = require('../../domain/money');

/**
 * NAY Financeira — Caderno Marco 4 §18 ("NAY Financeira"), Guia §13 ("Relatório semanal da NAY": FinanceHealthReport { freeCash, thirdPartyCash,
 * payables7d/30d, receivables7d/30d, overdueAmount, pendingReconciliations, pendingOwnerRepasses, provisionedCommissions, openHighRiskAnomalies,
 * breathingNeed, sourceSnapshotAt } — "A NAY recebe esse read model; não precisa varrer ledger bruto a cada pergunta") e DoD "NAY sem permissão de
 * execução financeira" / FIN-014 ("NAY recomenda, não paga").
 *
 * Os números vêm do READ MODEL que o BI já mantém (analytics.rm_finance_health e analytics.rm_finance_sector_margin, recalculados pelo worker a cada
 * evento financeiro e pela agenda): nenhuma soma sobre o ledger por pergunta. As sugestões que apontam um lançamento a cobrar ou a pagar leem só a
 * fila de itens EM ABERTO (até 200, status PENDING, ordenada por vencimento) — a lista de trabalho, não o ledger (DI-M4CC-4). Se o read model ainda
 * não existe para a empresa ou está mais velho que o limite de atualização do domínio Financeiro (analytics.freshness.max_minutos.FINANCE), a
 * conclusão é PARCIAL e diz a data do retrato.
 *
 * Fronteira "recomenda, não paga", garantida por construção (e travada por test/marco4.nayNoExecution.test.js): só SELECT e a linha de auditoria
 * da execução em "ai"."ai_runs". Não cria ledger, não liquida, não altera favorecido, não fecha período.
 */

const AGENT_NAME = 'NAY_FINANCEIRA';
const READ_MODEL = 'analytics.rm_finance_health';
const SECTOR_READ_MODEL = 'analytics.rm_finance_sector_margin';
const LIMITES =
  'A NAY Financeira só explica e sugere. Ela não cria ledger, não paga, não altera favorecido, não fecha período nem executa nenhuma ação: toda ação continua nas rotas humanas, com permissão, aprovação e MFA.';

function monthBounds(now) {
  const key = businessDateKey(now); // AAAA-MM-DD em São Paulo
  const [y, m] = key.split('-').map(Number);
  const fmt = (yy, mm) => `${yy}-${String(mm).padStart(2, '0')}`;
  return { current: fmt(y, m), previous: m === 1 ? fmt(y - 1, 12) : fmt(y, m - 1) };
}

// Fila de trabalho (itens em aberto) para as sugestões que citam um lançamento específico.
async function openEntries(transaction, nature, startToday) {
  return sequelize.query(
    `SELECT id, description, amount::text AS amount, due_at
       FROM finance.financial_entries
      WHERE status = 'PENDING' AND is_third_party_funds = false AND nature = :nature
        ${nature === 'RECEIVABLE' ? 'AND due_at < :startToday' : ''}
      ORDER BY due_at ASC NULLS LAST
      LIMIT 200`,
    { transaction, type: sequelize.QueryTypes.SELECT, replacements: { nature, startToday } }
  );
}

async function freshnessLimitMinutes(tenant, transaction) {
  const { readFreshnessParams } = require('../../../../features/analytics/metrics/freshness.settings'); // leitura tardia (dicionário de parâmetros)
  const params = await readFreshnessParams(tenant, transaction);
  return params.limits.FINANCE;
}

function completeness({ health, accounts, current, now, limitMinutes }) {
  const motivos = [];
  if (!health) {
    motivos.push('O retrato financeiro desta empresa (read model) ainda não foi calculado: os números ficam indisponíveis até a próxima atualização.');
    return motivos;
  }
  const idadeMin = Math.floor((now.getTime() - new Date(health.source_snapshot_at || health.refreshed_at).getTime()) / 60000);
  if (idadeMin > limitMinutes) motivos.push(`Retrato financeiro de ${health.as_of_date} com ${idadeMin} minuto(s), acima do limite de atualização de ${limitMinutes} minuto(s).`);
  if (accounts === 0) motivos.push('Nenhuma conta bancária em uso cadastrada: o caixa disponível não tem extrato que o sustente.');
  else if (!health.last_statement_import_date || health.last_statement_import_date.slice(0, 7) < current) {
    motivos.push(`Extrato bancário de ${current} ainda não importado (última importação: ${health.last_statement_import_date || 'nenhuma'}).`);
  }
  if (health.pending_reconciliations > 0) motivos.push(`${health.pending_reconciliations} transação(ões) de extrato ainda sem conciliação.`);
  return motivos;
}

/**
 * getFinanceInsights — explicações + sugestões da NAY Financeira para a empresa do contexto.
 */
async function getFinanceInsights(tenant, actorUserId, transaction, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const startToday = startOfBusinessDay(now);
  const { current, previous } = monthBounds(now);

  const health = await readModel.findLatestHealth(tenant.companyId, businessDateKey(now), transaction);
  const margins = await readModel.findSectorMargins(tenant.companyId, [current, previous], transaction);
  const accounts = await readModel.countActiveBankAccounts(transaction);
  const limitMinutes = await freshnessLimitMinutes(tenant, transaction);
  const thresholds = await resolveAntifraudThresholds(tenant, transaction);
  const growth = await buildSectorGrowth(margins, current, previous, (ids) => readModel.findResultCenterNames(ids, transaction));
  const overdueReceivables = await openEntries(transaction, 'RECEIVABLE', startToday);
  const pendingPayables = await openEntries(transaction, 'PAYABLE', startToday);
  const motivosParcial = completeness({ health, accounts, current, now, limitMinutes });

  const sourceSnapshotAt = health ? health.source_snapshot_at : null;
  const fonteReadModel = { readModel: READ_MODEL, asOfDate: health ? health.as_of_date : null, sourceSnapshotAt };
  const fonteSetores = { readModel: SECTOR_READ_MODEL, meses: [current, previous] };
  const explicacoes = buildExplanations({ health, margins, current, previous, fonteReadModel, fonteSetores });

  const daysBetween = (a, b) => Math.max(0, Math.round((b.getTime() - startOfBusinessDay(new Date(a)).getTime()) / 86400000));
  const fonteFila = { tabela: 'finance.financial_entries', filtro: 'itens em aberto (PENDING), até 200' };
  const overdueRanked = overdueReceivables
    .map((e) => {
      const dias = daysBetween(e.due_at, startToday);
      const cents = toCents(e.amount);
      // prioridade = valor × log2(dias+2): ordenação (não é dinheiro); o valor exibido sai dos centavos exatos.
      return { financialEntryId: e.id, descricao: e.description, valor: cents / 100, diasEmAtraso: dias, prioridade: Math.round(cents * Math.log2(dias + 2)) / 100, natureza: 'REALIZADO', fontes: [fonteFila] };
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
    reducaoCusto: growth.map((g) => ({ ...g, natureza: 'REALIZADO', fontes: [fonteSetores], razao: `Custo realizado do setor cresceu R$ ${g.crescimento.toFixed(2)} de ${previous} para ${current}.` })),
    priorizacaoPagaveis: pendingPayables.slice(0, 10).map((e, i) => ({
      ordem: i + 1,
      financialEntryId: e.id,
      descricao: e.description,
      valor: toCents(e.amount) / 100,
      vencimento: e.due_at,
      vencido: e.due_at ? new Date(e.due_at) < startToday : false,
      natureza: 'PREVISTO',
      fontes: [fonteFila],
      razao: 'Ordem por vencimento (vencidos primeiro). Pagamento só pelo fluxo de intenção + aprovação + MFA.',
    })),
  };

  const fontes = {
    readModels: [READ_MODEL, SECTOR_READ_MODEL],
    readModel: READ_MODEL,
    asOfDate: health ? health.as_of_date : null,
    sourceSnapshotAt,
    filaDeTrabalho: 'finance.financial_entries (itens em aberto, só nas sugestões que citam um lançamento)',
    cadastros: ['finance.bank_accounts', 'finance.result_centers'],
    regras: [{ codigo: 'FIN-005', ruleVersionId: thresholds.ruleVersionId || null, origem: thresholds.ruleVersionId ? 'Motor de Regras' : 'padrão (regra não publicada)' }],
  };

  const aiRun = await recordRuleRun(
    { groupId: tenant.groupId, companyId: tenant.companyId, userId: actorUserId || null },
    {
      agentName: AGENT_NAME,
      inputSummary: `Explicação financeira e sugestões (${current} x ${previous}).`,
      toolCallsJson: { method: 'RULE_BASED', readModels: fontes.readModels, asOfDate: fontes.asOfDate, sourceSnapshotAt, months: [current, previous], ruleVersions: fontes.regras },
      outputSummary: `${sugestoes.cobranca.length + sugestoes.renegociacao.length + sugestoes.reducaoCusto.length + sugestoes.priorizacaoPagaveis.length} sugestão(ões); conclusão ${motivosParcial.length ? 'PARCIAL' : 'completa'}. Nenhuma ação executada (FIN-014).`,
      groundingStatus: motivosParcial.length ? 'INSUFFICIENT_SOURCES' : 'GROUNDED',
    },
    transaction
  );

  return {
    agente: 'NAY Financeira',
    metodo: 'RULE_BASED',
    aiRunId: aiRun.id,
    geradoEm: now.toISOString(),
    sourceSnapshotAt,
    conclusaoParcial: motivosParcial.length > 0,
    motivosParcial,
    explicacoes,
    sugestoes,
    fontes,
    limites: LIMITES,
  };
}

module.exports = { getFinanceInsights, AGENT_NAME };
