'use strict';

/**
 * M9-D600 — armazenamento do núcleo de métricas do BI (schema "analytics"):
 * metric_definitions, metric_versions e metric_snapshots.
 *
 * Regras do livro (BI-007 e BI-008):
 *   - métrica alterada cria NOVA versão; a versão publicada é imutável (gatilho de banco);
 *   - snapshot é imutável: recalcular a mesma data-base com a mesma versão grava uma NOVA linha
 *     com revision_no + 1 e recalculated = true (a linha antiga permanece).
 *
 * Escrita: SÓ com a GUC app.analytics_writer = 'on' na transação (worker de BI, ou a rota de
 * publicação depois de checar `analytics:manage`). Sem ela, a RLS recusa e este serviço devolve
 * 403 ANALYTICS_WRITE_FORBIDDEN. O BI nunca escreve em tabela de outro módulo.
 *
 * Nada aqui é regra configurável: são invariantes de integridade do livro. Os parâmetros do BI
 * (frescor, retenção etc.) ficam nas demandas que os usam e são lidos de SETTINGS_SCHEMA.
 */

const { sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

const UNITS = ['BRL', 'PERCENT', 'COUNT', 'DAYS', 'HOURS', 'MINUTES', 'SECONDS', 'SCORE', 'NUMBER', 'PP', 'BRL_PER_UNIT'];
const DOMAINS = [
  'FINANCE', 'CRM', 'PROPERTIES', 'RENTAL', 'CONSTRUCTION', 'INVENTORY', 'LEGAL', 'CORRESPONDENT',
  'MARKETING', 'SUPPORT', 'TECH_AI',
];
const VALUE_NATURES = ['ACTUAL', 'PLANNED', 'ESTIMATED', 'PROJECTED'];
const SNAPSHOT_STATUSES = ['OK', 'STALE', 'DEGRADED', 'INCOMPLETE'];
const CRITICALITIES = ['CRITICAL', 'NORMAL'];
const SCOPE_LEVELS = ['GLOBAL', 'GROUP', 'COMPANY'];
const METRIC_CODE_RE = /^[a-z][a-z0-9]*[.][a-z][a-z0-9_]*$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MSG = {
  WRITE_FORBIDDEN: 'Somente o processo de atualização do BI grava indicadores.',
  IMMUTABLE: 'Versão publicada não pode ser alterada. Publique uma nova versão.',
  OVERLAP: 'Já existe versão vigente neste intervalo.',
  SCOPE_NOT_FOUND: 'Empresa não encontrada ou sem acesso.',
};

const invalid = (message) => AppError.badRequest(message, 'ANALYTICS_METRIC_INVALID');

/** Liga a gravação em "analytics" para ESTA transação (SET LOCAL: some no commit/rollback). */
async function enableAnalyticsWriter(transaction) {
  await sequelize.query("SELECT set_config('app.analytics_writer', 'on', true)", { transaction });
}

async function assertWriter(transaction) {
  const [[row]] = await sequelize.query("SELECT COALESCE(current_setting('app.analytics_writer', true), '') AS v", { transaction });
  if (row.v !== 'on') throw AppError.forbidden(MSG.WRITE_FORBIDDEN, 'ANALYTICS_WRITE_FORBIDDEN');
}

/** Converte erros crus do Postgres nos erros de negócio do livro (nunca vaza texto de driver). */
function translateAnalyticsDbError(err) {
  if (err instanceof AppError) return err;
  const code = err?.original?.code || err?.parent?.code || err?.code;
  const constraint = err?.original?.constraint || err?.parent?.constraint || '';
  let mapped = null;
  if (code === '42501') mapped = AppError.forbidden(MSG.WRITE_FORBIDDEN, 'ANALYTICS_WRITE_FORBIDDEN');
  else if (code === 'ANA01') mapped = AppError.conflict(MSG.IMMUTABLE, 'ANALYTICS_METRIC_VERSION_IMMUTABLE');
  else if (code === '23P01') mapped = AppError.conflict(MSG.OVERLAP, 'ANALYTICS_METRIC_VERSION_OVERLAP');
  else if (code === 'ANA02') mapped = invalid('Numeração de versão inválida: as versões seguem 1, 2, 3 sem buracos.');
  else if (code === 'ANA03') mapped = AppError.conflict('Snapshot é imutável. Grave uma nova revisão.', 'ANALYTICS_SNAPSHOT_IMMUTABLE');
  else if (code === 'ANA04') mapped = invalid('A versão precisa ter o mesmo escopo da definição da métrica.');
  else if (code === 'ANA05') mapped = AppError.notFound(MSG.SCOPE_NOT_FOUND, 'ANALYTICS_SCOPE_NOT_FOUND');
  else if (code === 'ANA06') mapped = invalid('A versão informada não pertence a esta métrica.');
  else if (code === '23505' && /metric_snapshots/.test(constraint)) {
    mapped = AppError.conflict('Já existe um snapshot para esta métrica, escopo e data-base.', 'ANALYTICS_SNAPSHOT_DUPLICATE');
  } else if (code === '23505' && /metric_versions/.test(constraint)) {
    mapped = AppError.conflict('Outra publicação desta métrica acabou de ser gravada. Recarregue e tente de novo.', 'ANALYTICS_METRIC_VERSION_CONFLICT');
  } else if (code === '23505') {
    mapped = AppError.conflict('Já existe uma métrica com este código neste escopo.', 'ANALYTICS_METRIC_CODE_DUPLICATE');
  } else if (code === '23514') mapped = invalid('Valor fora do permitido para esta métrica.');
  else if (code === '23503' && /company_id|group_id/.test(constraint)) mapped = AppError.notFound(MSG.SCOPE_NOT_FOUND, 'ANALYTICS_SCOPE_NOT_FOUND');
  else if (code === '23503') mapped = AppError.notFound('Métrica ou versão não encontrada.', 'ANALYTICS_METRIC_NOT_FOUND');
  if (mapped) mapped.cause = err;
  return mapped || err;
}

async function run(transaction, fn) {
  try {
    return await fn();
  } catch (err) {
    throw translateAnalyticsDbError(err);
  }
}

function requireOneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw invalid(`${label} inválido. Valores aceitos: ${allowed.join(', ')}.`);
}

function requireDate(value, label) {
  if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw invalid(`${label} deve ser uma data no formato AAAA-MM-DD.`);
  }
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${label} é obrigatório.`);
}

// ---------------------------------------------------------------------------------------- definições

async function createMetricDefinition(input, ctx, transaction) {
  await assertWriter(transaction);
  const {
    scopeLevel = 'COMPANY', groupId = null, companyId = null, metricCode, name, description = null, domain,
    criticality = 'NORMAL', ownerRole = null,
  } = input;
  requireOneOf(scopeLevel, SCOPE_LEVELS, 'Escopo');
  if (typeof metricCode !== 'string' || !METRIC_CODE_RE.test(metricCode)) {
    throw invalid('O código da métrica deve seguir o formato dominio.nome_em_snake (minúsculas, números e "_").');
  }
  requireText(name, 'O nome da métrica');
  requireOneOf(domain, DOMAINS, 'Domínio');
  requireOneOf(criticality, CRITICALITIES, 'Criticidade');
  if (scopeLevel === 'COMPANY' && (!companyId || !groupId)) throw invalid('Métrica de empresa exige empresa e grupo.');
  if (scopeLevel === 'GROUP' && (!groupId || companyId)) throw invalid('Métrica de grupo exige o grupo e não pode ter empresa.');
  if (scopeLevel === 'GLOBAL' && (groupId || companyId)) throw invalid('Métrica de catálogo global não tem empresa nem grupo.');

  return run(transaction, async () => {
    const [[row]] = await sequelize.query(
      `INSERT INTO analytics.metric_definitions
         (company_id, group_id, metric_code, name, description, domain, status, criticality, owner_role, group_scoped, created_by, updated_by)
       VALUES (:companyId, :groupId, :metricCode, :name, :description, :domain, 'DRAFT', :criticality, :ownerRole, :groupScoped, :actor, :actor)
       RETURNING *`,
      {
        replacements: {
          companyId: scopeLevel === 'GLOBAL' ? null : companyId,
          groupId: scopeLevel === 'GLOBAL' ? null : groupId,
          metricCode, name: name.trim(), description, domain, criticality, ownerRole,
          groupScoped: scopeLevel === 'GROUP',
          actor: ctx?.actorUserId || null,
        },
        transaction,
      }
    );
    return row;
  });
}

// ---------------------------------------------------------------------------------------- versões

function validateVersionInput(input) {
  requireText(input.formulaId, 'O id da fórmula');
  requireText(input.formulaSemantic, 'A definição da fórmula em português');
  requireOneOf(input.unit, UNITS, 'Unidade');
  requireOneOf(input.valueNature, VALUE_NATURES, 'Natureza do valor');
  requireDate(input.validFrom, 'O início da vigência');
  const rp = input.refreshPolicy;
  if (!rp || typeof rp !== 'object' || !['EVENT', 'SCHEDULE'].includes(rp.mode)) {
    throw invalid('A política de atualização deve ter modo EVENT ou SCHEDULE.');
  }
  if (rp.mode === 'SCHEDULE' && (typeof rp.cron !== 'string' || !rp.cron.trim())) throw invalid('A política SCHEDULE exige o cron.');
  if (input.formulaTestHash != null && !HASH_RE.test(input.formulaTestHash)) throw invalid('O hash do teste da fórmula deve ser SHA-256 em hexadecimal.');
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) throw invalid('Informe a versão vigente que você viu (0 se ainda não há).');
  if (input.expectedVersion >= 1) requireText(input.changeReason, 'O motivo da mudança');
}

/**
 * Publica uma nova versão (transação única: trava a definição, fecha a vigência anterior, insere a
 * versão e move o ponteiro). `expectedVersion` é o número da versão vigente que o chamador viu; se
 * outra publicação passou na frente, responde 409 ANALYTICS_METRIC_VERSION_CONFLICT.
 */
async function publishMetricVersion(input, ctx, transaction) {
  await assertWriter(transaction);
  validateVersionInput(input);

  return run(transaction, async () => {
    const [defs] = await sequelize.query('SELECT * FROM analytics.metric_definitions WHERE id = :id FOR UPDATE', {
      replacements: { id: input.definitionId }, transaction,
    });
    const def = defs[0];
    if (!def) throw AppError.notFound('Métrica não encontrada.', 'ANALYTICS_METRIC_NOT_FOUND');

    let previous = null;
    if (def.current_version_id) {
      const [prev] = await sequelize.query(
        `SELECT *, to_char(valid_from, 'YYYY-MM-DD') AS valid_from_text FROM analytics.metric_versions WHERE id = :id`,
        { replacements: { id: def.current_version_id }, transaction }
      );
      previous = prev[0] || null;
    }
    const currentNumber = previous ? previous.version : 0;
    if (currentNumber !== input.expectedVersion) {
      throw AppError.conflict(
        'Esta métrica foi publicada por outra pessoa enquanto você editava. Recarregue e publique de novo.',
        'ANALYTICS_METRIC_VERSION_CONFLICT',
        { versaoVigente: currentNumber }
      );
    }
    if (previous && input.validFrom <= previous.valid_from_text) {
      throw AppError.conflict(MSG.OVERLAP, 'ANALYTICS_METRIC_VERSION_OVERLAP');
    }
    if (previous) {
      await sequelize.query(
        'UPDATE analytics.metric_versions SET valid_until = :vf, updated_at = now() WHERE id = :id AND valid_until IS NULL',
        { replacements: { vf: input.validFrom, id: previous.id }, transaction }
      );
    }
    const [[version]] = await sequelize.query(
      `INSERT INTO analytics.metric_versions
         (company_id, group_id, metric_id, version, formula_id, formula_semantic, source_read_model, dimensions, filters, unit,
          refresh_policy, quality_rule, value_nature, formula_test_hash, valid_from, published_by, change_reason)
       VALUES (:companyId, :groupId, :metricId, :version, :formulaId, :formulaSemantic, :sourceReadModel, CAST(:dimensions AS jsonb),
          CAST(:filters AS jsonb), :unit, CAST(:refreshPolicy AS jsonb), CAST(:qualityRule AS jsonb), :valueNature, :formulaTestHash,
          :validFrom, :actor, :changeReason)
       RETURNING *`,
      {
        replacements: {
          companyId: def.company_id, groupId: def.group_id, metricId: def.id, version: currentNumber + 1,
          formulaId: input.formulaId, formulaSemantic: input.formulaSemantic, sourceReadModel: input.sourceReadModel || null,
          dimensions: JSON.stringify(input.dimensions || []), filters: JSON.stringify(input.filters || {}),
          unit: input.unit, refreshPolicy: JSON.stringify(input.refreshPolicy),
          qualityRule: input.qualityRule == null ? null : JSON.stringify(input.qualityRule),
          valueNature: input.valueNature, formulaTestHash: input.formulaTestHash || null, validFrom: input.validFrom,
          actor: ctx?.actorUserId || null, changeReason: input.changeReason || null,
        },
        transaction,
      }
    );
    await sequelize.query(
      `UPDATE analytics.metric_definitions SET current_version_id = :v, status = 'PUBLISHED', updated_by = :actor, updated_at = now() WHERE id = :id`,
      { replacements: { v: version.id, actor: ctx?.actorUserId || null, id: def.id }, transaction }
    );
    await registrarAuditoria(
      {
        groupId: ctx.groupId,
        companyId: ctx.companyId,
        actorUserId: ctx.actorUserId,
        action: 'analytics.metric.publish',
        entityType: 'analytics.metric_version',
        entityId: version.id,
        beforeJson: { metricCode: def.metric_code, versaoVigente: currentNumber, currentVersionId: def.current_version_id, status: def.status },
        afterJson: { metricCode: def.metric_code, versao: version.version, versionId: version.id, unit: version.unit, valueNature: version.value_nature, validFrom: input.validFrom },
        reason: input.changeReason ? `Publicação da métrica ${def.metric_code}: ${input.changeReason}` : `Publicação da métrica ${def.metric_code} (versão ${version.version})`,
      },
      transaction
    );
    return version;
  });
}

/** Versão da métrica vigente numa data (a fórmula que valia "naquele dia"). */
async function getMetricVersionAt(metricId, date, transaction) {
  requireDate(date, 'A data');
  const [rows] = await sequelize.query(
    `SELECT * FROM analytics.metric_versions
      WHERE metric_id = :metricId AND valid_from <= :date AND (valid_until IS NULL OR valid_until > :date)
      ORDER BY version DESC LIMIT 1`,
    { replacements: { metricId, date }, transaction }
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------------------- snapshots

function validateSnapshotInput(input) {
  requireOneOf(input.status || 'OK', SNAPSHOT_STATUSES, 'Status do snapshot');
  if (!input.metricId || !input.metricVersionId) throw invalid('Informe a métrica e a versão usada no cálculo.');
  if (!input.groupId) throw invalid('Informe o grupo.');
  if (typeof input.scopeType !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(input.scopeType)) throw invalid('Tipo de escopo inválido.');
  if (!input.scopeId) throw invalid('Informe o escopo.');
  if ((input.scopeType === 'GROUP') !== !input.companyId) throw invalid('Snapshot de grupo não tem empresa; os demais exigem a empresa.');
  requireDate(input.periodStart, 'O início do período');
  requireDate(input.periodEnd, 'O fim do período');
  requireDate(input.asOfDate, 'A data-base');
  if (typeof input.calcHash !== 'string' || !HASH_RE.test(input.calcHash)) throw invalid('O hash do cálculo deve ser SHA-256 em hexadecimal.');
}

async function insertSnapshot(input, revisionNo, recalculated, transaction) {
  const [[row]] = await sequelize.query(
    `INSERT INTO analytics.metric_snapshots
       (company_id, group_id, metric_id, metric_version_id, scope_type, scope_id, dimension_key, period_start, period_end, as_of_date,
        value_numeric, value_text, status, source_snapshot_at, refreshed_at, read_model_version, source_refs, calc_hash,
        revision_no, recalculated, captured_late)
     VALUES (:companyId, :groupId, :metricId, :metricVersionId, :scopeType, :scopeId, :dimensionKey, :periodStart, :periodEnd, :asOfDate,
        :valueNumeric, :valueText, :status, :sourceSnapshotAt, COALESCE(:refreshedAt, now()), :readModelVersion, CAST(:sourceRefs AS jsonb),
        :calcHash, :revisionNo, :recalculated, :capturedLate)
     RETURNING *`,
    {
      replacements: {
        companyId: input.companyId || null, groupId: input.groupId, metricId: input.metricId, metricVersionId: input.metricVersionId,
        scopeType: input.scopeType, scopeId: input.scopeId, dimensionKey: input.dimensionKey || '',
        periodStart: input.periodStart, periodEnd: input.periodEnd, asOfDate: input.asOfDate,
        valueNumeric: input.valueNumeric ?? null, valueText: input.valueText ?? null, status: input.status || 'OK',
        sourceSnapshotAt: input.sourceSnapshotAt || null, refreshedAt: input.refreshedAt || null,
        readModelVersion: input.readModelVersion ?? null, sourceRefs: JSON.stringify(input.sourceRefs || []),
        calcHash: input.calcHash, revisionNo, recalculated, capturedLate: input.capturedLate === true,
      },
      transaction,
    }
  );
  return row;
}

/** Primeira gravação da data-base (revision_no = 1). Duplicata responde 409 ANALYTICS_SNAPSHOT_DUPLICATE. */
async function recordSnapshot(input, transaction) {
  await assertWriter(transaction);
  validateSnapshotInput(input);
  return run(transaction, () => insertSnapshot(input, 1, false, transaction));
}

const KEY_WHERE = `metric_id = :metricId AND metric_version_id = :metricVersionId AND scope_type = :scopeType AND scope_id = :scopeId
  AND dimension_key = :dimensionKey AND period_start = :periodStart AND period_end = :periodEnd AND as_of_date = :asOfDate`;

/**
 * Rebuild: grava NOVA revisão (revision_no + 1, recalculated = true) da MESMA versão e data-base; a linha
 * antiga é preservada. O processo auditado completo (motivo, aprovação) é M9-D608; aqui fica o mecanismo.
 */
async function recordSnapshotRevision(input, transaction) {
  await assertWriter(transaction);
  validateSnapshotInput(input);
  return run(transaction, async () => {
    const [[last]] = await sequelize.query(`SELECT MAX(revision_no) AS n FROM analytics.metric_snapshots WHERE ${KEY_WHERE}`, {
      replacements: { ...input, dimensionKey: input.dimensionKey || '' }, transaction,
    });
    if (!last || last.n == null) {
      throw AppError.notFound('Não há snapshot anterior desta data-base para revisar.', 'ANALYTICS_SNAPSHOT_NOT_FOUND');
    }
    return insertSnapshot(input, Number(last.n) + 1, true, transaction);
  });
}

/** Trilha completa (todas as revisões) de uma data-base, da mais antiga para a mais nova. */
async function listSnapshotRevisions({ metricId, metricVersionId = null, scopeType, scopeId, asOfDate, dimensionKey = '' }, transaction) {
  requireDate(asOfDate, 'A data-base');
  const [rows] = await sequelize.query(
    `SELECT * FROM analytics.metric_snapshots
      WHERE metric_id = :metricId AND scope_type = :scopeType AND scope_id = :scopeId AND dimension_key = :dimensionKey
        AND as_of_date = :asOfDate AND (CAST(:metricVersionId AS uuid) IS NULL OR metric_version_id = CAST(:metricVersionId AS uuid))
      ORDER BY metric_version_id, revision_no ASC`,
    { replacements: { metricId, metricVersionId, scopeType, scopeId, asOfDate, dimensionKey }, transaction }
  );
  return rows;
}

/** Leitura "como estava naquele dia": a maior revision_no da data-base (de qualquer versão, a mais nova). */
async function getLatestSnapshot({ metricId, scopeType, scopeId, asOfDate, dimensionKey = '' }, transaction) {
  requireDate(asOfDate, 'A data-base');
  const [rows] = await sequelize.query(
    `SELECT s.* FROM analytics.metric_snapshots s
      WHERE s.metric_id = :metricId AND s.scope_type = :scopeType AND s.scope_id = :scopeId
        AND s.dimension_key = :dimensionKey AND s.as_of_date = :asOfDate
      ORDER BY (SELECT v.version FROM analytics.metric_versions v WHERE v.id = s.metric_version_id) DESC, s.revision_no DESC
      LIMIT 1`,
    { replacements: { metricId, scopeType, scopeId, asOfDate, dimensionKey }, transaction }
  );
  return rows[0] || null;
}

module.exports = {
  UNITS,
  DOMAINS,
  VALUE_NATURES,
  enableAnalyticsWriter,
  assertWriter,
  translateAnalyticsDbError,
  createMetricDefinition,
  publishMetricVersion,
  getMetricVersionAt,
  recordSnapshot,
  recordSnapshotRevision,
  listSnapshotRevisions,
  getLatestSnapshot,
};
