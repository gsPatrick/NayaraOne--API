'use strict';

const signals = require('./signals.repository');
const anomalies = require('./anomaly.repository');
const { anomalyKindOf } = require('./anomaly.signal');

/**
 * Regras de detecção (M9-D824 §3.2): soma agregada no banco, na transação da decisão, sobre a janela deslizante que termina no sinal recém gravado.
 *  - Leitura: soma de READ e COPY da MESMA classe (HIGH ou RESTRICTED); anomalia quando PASSA do limite da classe.
 *  - Exportação: soma de EXPORT (aprovados e bloqueados); anomalia quando ATINGE o limite ("3 ou mais").
 * A revisão humana zera a contagem: sinais anteriores à última revisão do usuário naquele tipo já foram julgados. `thresholds` vem de parseThresholds (anomaly.settings.js). Devolve null (nada a abrir) ou { kind, rule, windowMinutes, trigger }.
 */
async function detect(tenant, row, thresholds, transaction) {
  const kind = anomalyKindOf(row.kind);
  const exportKind = kind === 'EXPORT';
  const rule = exportKind ? 'EXPORT' : row.classification;
  const { limit, minutes } = thresholds[rule];
  const until = new Date(row.occurredAt);
  const reviewed = await anomalies.lastReviewedAt(tenant.companyId, row.userId, kind, transaction);
  const windowStart = new Date(until.getTime() - minutes * 60 * 1000);
  const since = reviewed && reviewed > windowStart ? reviewed : windowStart;
  const sum = await signals.sumInWindow(
    tenant, row.userId, { kinds: exportKind ? ['EXPORT'] : ['READ', 'COPY'], classification: exportKind ? null : row.classification, since, until }, transaction
  );
  const exceeded = exportKind ? sum.total >= limit : sum.total > limit;
  if (!exceeded) return null;
  return {
    kind, rule, windowMinutes: minutes,
    trigger: { rule, classification: exportKind ? null : row.classification, total: sum.total, denied: sum.denied, signals: sum.signals, limit, windowMinutes: minutes, windowStart: since.toISOString(), windowEnd: until.toISOString() },
  };
}

module.exports = { detect };
