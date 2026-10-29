'use strict';

const { sequelize } = require('../../models');
const { startOfBusinessDay } = require('../../utils/businessDate');

// Sugestões de cobrança para o agente financeiro da camada de IA (M9-D036): somente leitura. Pega os recebíveis próprios pendentes e vencidos
// da empresa (RLS do contexto), ordena pela mesma prioridade do relatório do Marco 4 (valor x log2(dias em atraso + 2)) e classifica cada um:
// vencido até `renegotiateAfterDays` dias é COBRANCA; acima disso, RENEGOCIACAO. Nada é cobrado nem negociado: a saída vira recomendação para uma pessoa.
const DAY = 86400000;
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

async function listCollectionSuggestions(transaction, { limit, renegotiateAfterDays, now = new Date() }) {
  const today = startOfBusinessDay(now);
  const rows = await sequelize.query(
    `SELECT id, amount::numeric AS amount, due_at
       FROM finance.financial_entries
      WHERE status = 'PENDING' AND is_third_party_funds = false AND nature = 'RECEIVABLE' AND due_at < :today
      ORDER BY due_at ASC
      LIMIT 500`,
    { transaction, type: sequelize.QueryTypes.SELECT, replacements: { today } }
  );
  const ranked = rows.map((r) => {
    const days = Math.max(0, Math.round((today.getTime() - startOfBusinessDay(new Date(r.due_at)).getTime()) / DAY));
    const amount = round2(r.amount);
    return { financialEntryId: r.id, amount, daysOverdue: days, priority: amount * Math.log2(days + 2), kind: days <= renegotiateAfterDays ? 'COBRANCA' : 'RENEGOCIACAO' };
  }).sort((a, b) => b.priority - a.priority || (a.financialEntryId < b.financialEntryId ? -1 : 1));
  return { generatedAt: now.toISOString(), source: 'finance.financial_entries', total: ranked.length, items: ranked.slice(0, limit) };
}

module.exports = { listCollectionSuggestions };
