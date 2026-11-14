'use strict';

/**
 * M9-D699 (3.1) — SQL da massa de carga do BI. Tudo é função pura da semente: ids = md5(semente:tipo:empresa:n)::uuid, valores e datas derivados
 * do mesmo hash, relativos à data âncora. Mesma semente + mesma âncora + mesmos tamanhos = mesmas linhas (e o mesmo digest). Gravação por
 * conexão de superusuário com session_replication_role = replica (sem FK nem gatilho): só em banco descartável.
 * Cada função devolve { sql, rows } para uma empresa; :seed, :anchor, :gid, :cid, :days e :n são parâmetros (nunca texto concatenado).
 */
const HASH = (kind) => `('x' || substr(md5(CAST(:seed AS text) || ':${kind}:' || CAST(:cid AS text) || ':' || g), 1, 6))::bit(24)::int`;
const ID = (kind) => `CAST(md5(CAST(:seed AS text) || ':${kind}:' || CAST(:cid AS text) || ':' || g) AS uuid)`;
const AT = (offset) => `(CAST(:anchor AS date) - (${offset}) + time '15:00')`; // instante às 15:00 UTC (12:00 de São Paulo) do dia

const entries = {
  table: 'finance.financial_entries', count: 'entries',
  sql: `INSERT INTO finance.financial_entries (id, group_id, company_id, entry_type, nature, amount, status, due_at, settled_at, competence_month, result_center_id, created_at, updated_at)
    SELECT ${ID('entry')}, :gid, :cid, CASE WHEN g % 2 = 0 THEN 'CREDIT' ELSE 'DEBIT' END, CASE WHEN g % 2 = 0 THEN 'RECEIVABLE' ELSE 'PAYABLE' END,
           (1 + ${HASH('amt')} % 5000000) / 100.0,
           CASE WHEN g % 10 < 6 THEN 'SETTLED' WHEN g % 10 < 9 THEN 'PENDING' ELSE 'CANCELLED' END,
           ${AT('(g % :days)')}, CASE WHEN g % 10 < 6 THEN ${AT('(g % :days)')} END,
           to_char(CAST(:anchor AS date) - (g % :days), 'YYYY-MM'),
           CAST(md5(CAST(:seed AS text) || ':center:' || CAST(:cid AS text) || ':' || (g % 4)) AS uuid), ${AT('(g % :days)')}, ${AT('(g % :days)')}
      FROM generate_series(1, :n) g`,
};

const bankTransactions = {
  table: 'finance.bank_transactions', count: 'bankTransactions',
  sql: `INSERT INTO finance.bank_transactions (id, group_id, company_id, bank_account_id, amount, transaction_date, created_at, updated_at)
    SELECT ${ID('bank')}, :gid, :cid, CAST(md5(CAST(:seed AS text) || ':account:' || CAST(:cid AS text) || ':' || (g % 3)) AS uuid),
           CASE WHEN g % 2 = 0 THEN 1 ELSE -1 END * (1 + ${HASH('bamt')} % 2000000) / 100.0, ${AT('(g % 60)')}, ${AT('1')}, ${AT('1')}
      FROM generate_series(1, :n) g`,
};

const opportunities = {
  table: 'crm.opportunities', count: 'opportunities',
  // Etapa final (WON/LOST, as do livro desde a DI-M3CA-3) nasce com a data de fechamento, como no fluxo real; o BI exige closed_at nelas.
  sql: `INSERT INTO crm.opportunities (id, group_id, company_id, person_id, owner_user_id, stage, lead_source, next_action, created_at, updated_at, closed_at)
    SELECT ${ID('opp')}, :gid, :cid, ${ID('person')}, CAST(md5(CAST(:seed AS text) || ':broker:' || CAST(:cid AS text) || ':' || (g % 5)) AS uuid),
           (ARRAY['NEW', 'CONTACTED', 'VISIT', 'PROPOSAL', 'WON', 'LOST'])[1 + g % 6], (ARRAY['SITE', 'PORTAL', 'INDICACAO', 'WHATSAPP'])[1 + g % 4], 'Ligar para o cliente',
           ${AT('(g % :days)')}, ${AT('(g % :days)')}, CASE WHEN g % 6 IN (4, 5) THEN ${AT('(g % :days)')} END
      FROM generate_series(1, :n) g`,
};

const properties = {
  table: 'real_estate.properties', count: 'properties',
  sql: `INSERT INTO real_estate.properties (id, group_id, company_id, title, property_type, internal_code, availability_status, publication_status, created_by, created_at, updated_at)
    SELECT ${ID('prop')}, :gid, :cid, 'Imóvel de carga ' || g, 'RESIDENTIAL', 'LC-' || substr(md5(CAST(:seed AS text) || ':code:' || CAST(:cid AS text) || ':' || g), 1, 14),
           (ARRAY['AVAILABLE', 'RENTED', 'SOLD'])[1 + g % 3], 'PUBLISHED', CAST(md5(CAST(:seed AS text) || ':broker:' || CAST(:cid AS text) || ':' || (g % 5)) AS uuid), ${AT('(g % :days)')}, ${AT('(g % :days)')}
      FROM generate_series(1, :n) g`,
};

const projects = {
  table: 'construction.projects', count: 'projects',
  sql: `INSERT INTO construction.projects (id, group_id, company_id, name, status, starts_at, ends_at_planned, budget_amount, created_at, updated_at)
    SELECT ${ID('project')}, :gid, :cid, 'Obra de carga ' || g, 'ACTIVE', ${AT('(g % :days + 60)')}, ${AT('(0 - 180)')}, (1000000 + g * 1000), ${AT('(g % :days)')}, ${AT('(g % :days)')} FROM generate_series(1, :n) g`,
};

const stages = {
  table: 'construction.project_stages', count: 'stages',
  sql: `INSERT INTO construction.project_stages (id, group_id, company_id, project_id, name, sequence, planned_cost, planned_pct, measured_pct, status, ends_at, created_at, updated_at)
    SELECT ${ID('stage')}, :gid, :cid, CAST(md5(CAST(:seed AS text) || ':project:' || CAST(:cid AS text) || ':' || (1 + g % GREATEST(:projects, 1))) AS uuid),
           'Etapa ' || g, g, (1 + ${HASH('scost')} % 9000000) / 100.0, 50, 40, 'IN_PROGRESS', ${AT('(0 - 90)')}, ${AT('(g % :days)')}, ${AT('(g % :days)')}
      FROM generate_series(1, :n) g`,
};

const measurements = {
  table: 'construction.stage_measurements', count: 'measurements',
  sql: `INSERT INTO construction.stage_measurements (id, group_id, company_id, project_stage_id, measured_pct, measured_at, total_amount, created_at, updated_at)
    SELECT ${ID('measure')}, :gid, :cid, CAST(md5(CAST(:seed AS text) || ':stage:' || CAST(:cid AS text) || ':' || (1 + g % GREATEST(:stages, 1))) AS uuid),
           (1 + g % 100), CAST(${AT('(g % :days)')} AS date), (1 + g % 90000) / 10.0, ${AT('(g % :days)')}, ${AT('(g % :days)')}
      FROM generate_series(1, :n) g`,
};

const dailyReports = {
  table: 'construction.daily_reports', count: 'dailyReports', // (obra, dia) único: o dia anda a cada volta completa sobre as obras
  sql: `INSERT INTO construction.daily_reports (id, group_id, company_id, project_id, report_date, created_at, updated_at)
    SELECT ${ID('report')}, :gid, :cid, CAST(md5(CAST(:seed AS text) || ':project:' || CAST(:cid AS text) || ':' || (1 + g % GREATEST(:projects, 1))) AS uuid),
           CAST(${AT('((g / GREATEST(:projects, 1)) % :days)')} AS date), ${AT('((g / GREATEST(:projects, 1)) % :days)')}, ${AT('((g / GREATEST(:projects, 1)) % :days)')}
      FROM generate_series(1, :n) g`,
};

/** Ordem de gravação (pais antes dos filhos) e de limpeza (inversa). */
const TABLES = [entries, bankTransactions, opportunities, properties, projects, stages, measurements, dailyReports];

/** Colunas que entram no digest (nunca instantes de gravação que mudam a cada execução). */
const DIGEST_COLUMNS = {
  'finance.financial_entries': 'id, amount, status, due_at, settled_at, competence_month, result_center_id', 'finance.bank_transactions': 'id, bank_account_id, amount, transaction_date',
  'crm.opportunities': 'id, stage, lead_source, created_at', 'real_estate.properties': 'id, internal_code, availability_status, created_at',
  'construction.projects': 'id, name, created_at', 'construction.project_stages': 'id, project_id, planned_cost, sequence', 'construction.stage_measurements': 'id, project_stage_id, measured_pct, measured_at',
  'construction.daily_reports': 'id, project_id, report_date',
};

module.exports = { TABLES, DIGEST_COLUMNS };
