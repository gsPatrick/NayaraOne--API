'use strict';

/**
 * Unidade do número de um alerta (alias `u`, coluna `u.unit`), lida do snapshot do alerta: o último avaliado (last_snapshot_id) ou, sem ele,
 * o que abriu o alerta (metric_snapshot_id). Usado pela listagem de alertas (GET /analytics/alerts, ack) e pelo Centro de Comando.
 *
 * Por que CASE e não `s.id = COALESCE(i.last_snapshot_id, i.metric_snapshot_id)`: analytics.metric_snapshots tem RLS, e com a política o
 * PostgreSQL não usa a chave primária para uma condição com COALESCE de colunas de fora; lia a tabela inteira (2,5 GB na homologação) uma vez
 * por alerta. Com 29 alertas abertos, o Centro de Comando e o semáforo passavam de 10 s e caíam em 504 ANALYTICS_QUERY_TIMEOUT (16/11/2026).
 * Com a coluna direto em cada ramo, cada alerta faz uma busca pelo índice (15 ms no total, mesmo cenário). A regra é a mesma do COALESCE.
 * Prova: test/marco9/analytics/alertUnit.indice.test.js.
 */
const UNIT_OF = (col) => `(SELECT v.unit FROM analytics.metric_snapshots s JOIN analytics.metric_versions v ON v.id = s.metric_version_id WHERE s.id = ${col})`;

const ALERT_UNIT_LATERAL_SQL = `LEFT JOIN LATERAL (SELECT CASE WHEN i.last_snapshot_id IS NOT NULL THEN ${UNIT_OF('i.last_snapshot_id')}
                                              ELSE ${UNIT_OF('i.metric_snapshot_id')} END AS unit) u ON true`;

module.exports = { ALERT_UNIT_LATERAL_SQL };
