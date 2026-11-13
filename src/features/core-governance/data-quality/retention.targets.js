'use strict';

const { TIME_ZONE, DISPOSITIONS } = require('./retention.constants');

/**
 * Catálogo dos tipos de dado que a retenção governa (M9-D911 §3.3). Cada alvo diz: a tabela, a data de cada gatilho que ele aceita (SQL com o alias `t`), o filtro
 * de base, o predicado de cada exceção que ele sabe avaliar (SQL com o alias `t`; exceção sem predicado nunca está ativa nesse alvo), a entidade que a interface
 * de legal hold (holdGuard) recebe, as disposições que ele suporta e, para ANONYMIZE, as colunas (e as tabelas filhas) que levam o valor irreversível. A política
 * escolhe os alvos pelo `data_types`. Alvo do tipo FUNCTION não tem tabela própria: executa uma função de retenção já existente (integration.purge_expired, M9-D244).
 * `distinct: true` marca coluna com índice único: o valor irreversível dela é sempre derivado do hash (o valor fixo repetiria e quebraria o índice).
 */
const LOCAL = (column) => `(${column} AT TIME ZONE '${TIME_ZONE}')::date`;
const CLOSED_CASE = "t.status = 'CLOSED'";
const OPEN_CASE_OF = (contractColumn) => `EXISTS (SELECT 1 FROM legal.legal_cases lc WHERE lc.contract_id = ${contractColumn} AND lc.status <> 'CLOSED' AND lc.deleted_at IS NULL)`;
const ALL = [DISPOSITIONS.REVIEW, DISPOSITIONS.ARCHIVE];

const TARGETS = Object.freeze({
  FISCAL_OBLIGATIONS: {
    code: 'FISCAL_OBLIGATIONS', label: 'Obrigações fiscais', schema: 'correspondent', table: 'fiscal_obligations', holdEntityType: 'FISCAL_OBLIGATION',
    baseWhere: 'TRUE', triggers: { FISCAL_PERIOD_END: 'make_date(t.reference_year, 12, 31)' },
    exceptions: { OPEN_OBLIGATION: "t.status <> 'COMPLETED'" }, dispositions: ALL,
  },
  TAX_DOCUMENTS: {
    code: 'TAX_DOCUMENTS', label: 'Documentos fiscais (notas)', schema: 'finance', table: 'tax_documents', holdEntityType: 'TAX_DOCUMENT',
    baseWhere: 't.deleted_at IS NULL AND t.issued_at IS NOT NULL', triggers: { FISCAL_PERIOD_END: `(date_trunc('month', ${LOCAL('t.issued_at')}) + interval '1 month - 1 day')::date` },
    exceptions: { ONGOING_LITIGATION: OPEN_CASE_OF('t.contract_id') }, dispositions: ALL, amountSql: 't.amount',
  },
  CONTRACTS: {
    code: 'CONTRACTS', label: 'Contratos', schema: 'legal', table: 'contracts', holdEntityType: 'CONTRACT',
    baseWhere: 't.deleted_at IS NULL AND t.ends_at IS NOT NULL', triggers: { CONTRACT_END: LOCAL('t.ends_at') },
    exceptions: { ONGOING_LITIGATION: OPEN_CASE_OF('t.id'), OPEN_OBLIGATION: "t.status IN ('ACTIVE', 'SUSPENDED')" }, dispositions: ALL, amountSql: 't.total_value',
  },
  LEGAL_CASES: {
    code: 'LEGAL_CASES', label: 'Processos jurídicos', schema: 'legal', table: 'legal_cases', holdEntityType: 'LEGAL_CASE',
    baseWhere: `t.deleted_at IS NULL AND ${CLOSED_CASE}`, triggers: { CASE_CLOSED: LOCAL('t.updated_at') },
    exceptions: { ONGOING_LITIGATION: "COALESCE(t.phase, 'CLOSED') <> 'CLOSED'" }, dispositions: ALL,
  },
  LEADS: {
    code: 'LEADS', label: 'Leads sem contrato', schema: 'people', table: 'persons', holdEntityType: 'PERSON',
    baseWhere: `t.deleted_at IS NULL AND EXISTS (SELECT 1 FROM crm.opportunities o0 WHERE o0.person_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM legal.contract_parties cp WHERE cp.person_id = t.id AND cp.deleted_at IS NULL)`,
    triggers: {
      LEAD_LAST_CONTACT: LOCAL(`GREATEST(t.created_at, (SELECT max(m.created_at) FROM crm.messages m WHERE m.person_id = t.id), (SELECT max(o.updated_at) FROM crm.opportunities o WHERE o.person_id = t.id))`),
      PERSON_INACTIVE_SINCE: `CASE WHEN t.status <> 'ACTIVE' THEN ${LOCAL('t.updated_at')} END`,
    },
    exceptions: { OPEN_OBLIGATION: "EXISTS (SELECT 1 FROM crm.opportunities oa WHERE oa.person_id = t.id AND oa.stage NOT IN ('WON', 'LOST', 'CLOSED_WON', 'CLOSED_LOST', 'WITHDRAWN'))" },
    dispositions: [DISPOSITIONS.ANONYMIZE, DISPOSITIONS.REVIEW],
    anonymize: {
      columns: [{ column: 'legal_name' }, { column: 'preferred_name' }, { column: 'tax_id_normalized', distinct: true }, { column: 'tax_id_normalized_hash', distinct: true }],
      related: [
        { schema: 'people', table: 'person_contacts', fk: 'person_id', columns: [{ column: 'value_normalized' }] },
        { schema: 'people', table: 'person_addresses', fk: 'person_id', columns: [{ column: 'zip_code' }, { column: 'street' }, { column: 'number' }, { column: 'complement' }, { column: 'neighborhood' }] },
      ],
    },
  },
  ACCESS_SIGNALS: {
    code: 'ACCESS_SIGNALS', label: 'Sinais de acesso (logs técnicos)', schema: 'governance', table: 'access_signals', holdEntityType: 'ACCESS_SIGNAL',
    baseWhere: 'TRUE', triggers: { TRANSACTION_DATE: LOCAL('t.occurred_at') }, exceptions: {}, dispositions: [DISPOSITIONS.DELETE, DISPOSITIONS.REVIEW],
  },
  AUDIT_LOG: {
    code: 'AUDIT_LOG', label: 'Auditoria de segurança', schema: 'audit', table: 'audit_log', holdEntityType: 'AUDIT_LOG',
    baseWhere: 'TRUE', triggers: { TRANSACTION_DATE: LOCAL('t.occurred_at') }, exceptions: {}, dispositions: ALL,
  },
  FILES: {
    code: 'FILES', label: 'Arquivos enviados', schema: 'people', table: 'files', holdEntityType: 'FILE',
    baseWhere: 't.deleted_at IS NULL', triggers: { UPLOAD_DATE: LOCAL('t.created_at') }, exceptions: {}, dispositions: [DISPOSITIONS.REVIEW],
  },
  INTEGRACAO: {
    code: 'INTEGRACAO', label: 'Dados técnicos de integração', kind: 'FUNCTION', holdEntityType: 'INTEGRATION', scheduleFromParams: true, autoApplySafe: true,
    tables: ['integration.provider_health', 'integration.integration_errors', 'integration.webhook_inbox', 'integration.dispatches'],
    triggers: { TRANSACTION_DATE: null }, exceptions: {}, dispositions: [DISPOSITIONS.DELETE],
  },
});

const get = (code) => TARGETS[code] || null;
/** Todas as tabelas (schema.tabela) que o alvo governa: a principal, as filhas da anonimização e, no alvo de função, as listadas. Serve ao registro de classificação (M9-D910). */
const tablesOf = (target) => (target.kind === 'FUNCTION' ? target.tables : [`${target.schema}.${target.table}`, ...((target.anonymize && target.anonymize.related) || []).map((r) => `${r.schema}.${r.table}`)]);
const isFunction = (target) => target.kind === 'FUNCTION';
const all = () => Object.values(TARGETS);

module.exports = { TARGETS, get, all, isFunction, tablesOf };
