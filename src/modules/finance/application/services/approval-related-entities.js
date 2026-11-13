'use strict';

const { BankAccount, FinancialEntry, Commission, CommissionInstallment, OwnerRepass } = require('../../../../models');

// Entidades aprováveis (o pedido é polimórfico: related_entity_type + related_entity_id) e o
// rótulo legível de cada uma na fila de aprovações.
const ENTITY_MODELS = {
  BankAccount,
  FinancialEntry,
  Commission,
  CommissionInstallment,
  OwnerRepass,
};

// ACHADO REAL (auditoria Nayara, rodada 4, 14/10/2026, M4-R01): a tela de Aprovações só exibia
// "Lançamento — <id curto>" (sem a descrição real) porque `approval_requests` é polimórfico e a
// listagem nunca resolvia a entidade relacionada — isso também quebrava a busca por texto, que
// filtrava sobre esse mesmo rótulo genérico. `relatedEntityLabel` resolve a descrição real da
// entidade (quando existir um campo apropriado) para cada request da página atual, em lotes por
// tipo (evita N+1 query por item).
// ACHADO REAL #2 (verificação complementar Nayara, 14/10/2026): a correção acima ainda deixava
// alguns itens só com o ID cru. Causa raiz: `FinancialEntry.description` é opcional
// (`allowNull: true`) — um lançamento criado sem descrição tinha `row.description` null, e o
// label virava null, caindo no fallback de ID cru no front (`lib/finance/labels.js`). O mesmo
// acontecia pra qualquer entidade não encontrada (apagada) ou tipo fora de `ENTITY_MODELS`.
// `buildFallbackLabel` garante que SEMPRE existe um texto legível em português — nunca null —
// usando os campos que toda entidade conhecida tem (nature/amount/dueAt pra FinancialEntry,
// criado-em pra qualquer coisa não mapeada).
const NATURE_LABELS = {
  PAYABLE: 'Despesa',
  RECEIVABLE: 'Receita',
  TRANSFER: 'Transferência',
  ADJUSTMENT: 'Ajuste',
  PENDING_CLASSIFICATION: 'A classificar',
};

function formatBrDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

function formatBrAmount(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildFallbackLabel(request) {
  const createdAt = formatBrDate(request.createdAt || request.created_at);
  return createdAt ? `Solicitação criada em ${createdAt}` : 'Solicitação de aprovação';
}

// M4PG: pedidos com fluxo próprio (pagamento, estorno, reabertura) descrevem-se pelo próprio retrato gravado no pedido.
function dedicatedLabel(r) {
  const snap = r.snapshotJson || {};
  const amount = formatBrAmount(r.amount);
  if (r.relatedEntityType === 'PaymentIntent') {
    const nome = snap.beneficiary && snap.beneficiary.name;
    return `Pagamento${amount ? ` de R$ ${amount}` : ''}${nome ? ` para ${nome}` : ''}${snap.description ? ` — ${snap.description}` : ''}`;
  }
  if (r.relatedEntityType === 'LedgerReversal') return `Estorno${amount ? ` de R$ ${amount}` : ''}${r.reason ? ` — ${r.reason}` : ''}`;
  if (r.relatedEntityType === 'PeriodReopen') {
    const month = r.payloadJson && r.payloadJson.referenceMonth;
    return `Reabertura do período ${month ? `${month.slice(5, 7)}/${month.slice(0, 4)}` : ''}`.trim();
  }
  return null;
}

async function resolveRelatedEntityLabels(requests, transaction) {
  const byType = {};
  requests.forEach((r) => {
    if (!byType[r.relatedEntityType]) byType[r.relatedEntityType] = new Set();
    byType[r.relatedEntityType].add(r.relatedEntityId);
  });

  const labelsByTypeAndId = {};
  await Promise.all(
    Object.entries(byType).map(async ([type, idSet]) => {
      const Model = ENTITY_MODELS[type];
      if (!Model) return;
      const ids = Array.from(idSet);
      const rows = await Model.findAll({ where: { id: ids }, transaction });
      labelsByTypeAndId[type] = {};
      rows.forEach((row) => {
        let label = null;
        if (type === 'FinancialEntry') {
          const natureLabel = NATURE_LABELS[row.nature] || row.nature || 'Lançamento';
          const amountLabel = formatBrAmount(row.amount);
          const dueLabel = formatBrDate(row.dueAt);
          label =
            row.description ||
            [natureLabel, amountLabel ? `R$ ${amountLabel}` : null, dueLabel ? `venc. ${dueLabel}` : null]
              .filter(Boolean)
              .join(' · ');
        } else if (type === 'BankAccount') label = row.pixKey ? `Chave PIX — ${row.pixKey}` : `${row.bankCode || 'Banco'} · Ag. ${row.agency || '—'} · Conta ${row.accountNumber || '—'}`;
        else if (type === 'Commission') label = `Comissão — ${row.percentage}% sobre ${row.baseAmount}`;
        else if (type === 'CommissionInstallment') label = `Parcela de comissão — ${row.amount || ''}`.trim();
        else if (type === 'OwnerRepass') label = `Repasse — ${row.referenceMonth || ''} · R$ ${row.netAmount || ''}`.trim();
        labelsByTypeAndId[type][row.id] = label || null;
      });
    })
  );

  return requests.map((r) => {
    const label = labelsByTypeAndId[r.relatedEntityType]?.[r.relatedEntityId] || dedicatedLabel(r) || buildFallbackLabel(r);
    const json = r.toJSON ? r.toJSON() : r;
    return { ...json, relatedEntityLabel: label };
  });
}

module.exports = {
  ENTITY_MODELS,
  resolveRelatedEntityLabels,
};
