'use strict';

const { StageMeasurement, MeasurementItem, Project } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const {
  publishStageMeasurementDecided,
  publishMeasurementSubmitted,
  publishMeasurementApproved,
  publishStageCompleted,
} = require('./constructionEvents.service');
const { getProjectStage } = require('./projectStages.service');
const financialEntriesService = require('../finance/financialEntries.service');
const { getOrCreateDefaultCostCenter } = require('../finance/costCenters.service');
// BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-07; contrato, Centro Financeiro
// BLINDADO v1, §4): a validação transversal "centro de custo obrigatório para despesa" virou
// fail-closed em createFinancialEntry — o fallback previsto no comentário abaixo (medição sem
// centro de custo configurado nem na medição nem na obra) agora precisa de um valor, não mais
// opcional. Ver getOrCreateDefaultCostCenter em costCenters.service.js.
const MEASUREMENT_COST_CENTER_CODE = 'OBRAS-MEDICOES';

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 59, 2026-10-06): quando a medição é
// criada/revisada SEM `items` (totalAmount vem direto do payload do usuário), o valor era
// persistido sem Number.isFinite — "NaN" passava o guard de decideStageMeasurement
// (Number(NaN) <= 0 é false) e aprovava a medição com totalAmount=NaN, propagando pro payable
// financeiro real (createPayableForMeasurement).
function assertValidManualTotalAmount(totalAmount) {
  if (totalAmount === undefined || totalAmount === null) return null;
  const numeric = Number(totalAmount);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw AppError.badRequest('"totalAmount" deve ser um número não negativo.', 'STAGE_MEASUREMENT_VALIDATION');
  }
  return numeric;
}

// M6-10/M6-21 — máquina de estados COMPLETA da medição (substitui o fluxo binário anterior
// PENDING_APPROVAL -> APPROVED/REJECTED):
//
//   DRAFT -> SUBMITTED -> REVIEWED -> APPROVED -> PAYABLE
//                |            |
//                +-- REJECTED +
//
// PAYABLE e REJECTED são terminais. SUPERSEDED é um terminal "lateral": nasce quando alguém
// tenta ALTERAR uma medição que já saiu de DRAFT (SUBMITTED/REVIEWED) — em vez de sobrescrever
// (o que destruiria o rastro de auditoria do que foi originalmente submetido), a medição
// corrente é marcada SUPERSEDED e uma nova revisão nasce em DRAFT, encadeada por
// `parentMeasurementId`/`revisionNumber` (ver `reviseStageMeasurement`).
const STATUSES = ['DRAFT', 'SUBMITTED', 'REVIEWED', 'APPROVED', 'PAYABLE', 'REJECTED', 'SUPERSEDED'];

function toCents(value) {
  return Math.round(Number(value) * 100);
}

function fromCents(cents) {
  return (cents / 100).toFixed(2);
}

function assertNonNegativeItem(item) {
  const quantity = Number(item.quantity);
  const unitPrice = Number(item.unitPrice);
  if (!item.description || !String(item.description).trim()) {
    throw AppError.badRequest('Todo item de medição precisa de "description".', 'MEASUREMENT_ITEM_VALIDATION');
  }
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw AppError.badRequest('"quantity" do item deve ser um número maior ou igual a zero.', 'MEASUREMENT_ITEM_VALIDATION');
  }
  if (!Number.isFinite(unitPrice) || unitPrice < 0) {
    throw AppError.badRequest('"unitPrice" do item deve ser um número maior ou igual a zero.', 'MEASUREMENT_ITEM_VALIDATION');
  }
}

/**
 * createMeasurementItems — cria os itens (M6-11) de uma medição e devolve o total (em string
 * com 2 casas, mesma precisão do DECIMAL(18,2)) — soma feita em CENTAVOS inteiros para não
 * sofrer erro de arredondamento de ponto flutuante (mesmo padrão de financialEntries.service.js).
 */
async function createMeasurementItems(measurement, items, actorUserId, transaction) {
  let totalCents = 0;
  const created = [];
  for (const item of items) {
    assertNonNegativeItem(item);
    const quantity = Number(item.quantity);
    const unitPrice = Number(item.unitPrice);
    const totalItemCents = Math.round(quantity * toCents(unitPrice));
    totalCents += totalItemCents;
    // eslint-disable-next-line no-await-in-loop
    const row = await MeasurementItem.create(
      {
        groupId: measurement.groupId,
        companyId: measurement.companyId,
        measurementId: measurement.id,
        description: item.description,
        quantity,
        unitPrice,
        total: fromCents(totalItemCents),
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
    created.push(row);
  }
  return { items: created, totalAmount: fromCents(totalCents) };
}

/**
 * createStageMeasurement — registra uma NOVA medição (append-only) em status DRAFT.
 * Aceita `items` (M6-11, opcional): quando informado, cria as linhas de measurement_items e
 * calcula `totalAmount` (é esse valor que vira a obrigação financeira ao aprovar — ver
 * `decideStageMeasurement`). Sem itens, `totalAmount` fica nulo até ser informado explicitamente
 * (não é possível aprovar uma medição sem valor — ver guarda em `decideStageMeasurement`).
 */
async function createStageMeasurement(projectStageId, payload, actorUserId, transaction) {
  const { groupId, companyId, measuredPct, measuredAt, notes, items, totalAmount, costCenterId, idempotencyKey } = payload;
  if (!groupId || !companyId || measuredPct === undefined || measuredPct === null || !measuredAt) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "measuredPct" e "measuredAt" são obrigatórios.',
      'STAGE_MEASUREMENT_VALIDATION'
    );
  }
  const numericPct = Number(measuredPct);
  if (!Number.isFinite(numericPct) || numericPct < 0 || numericPct > 100) {
    throw AppError.badRequest('"measuredPct" deve ser um número entre 0 e 100.', 'STAGE_MEASUREMENT_VALIDATION');
  }
  // BUG REAL CORRIGIDO (auditoria Marco 6, ciclo 12): "measuredAt" ia direto pro create() sem
  // nenhuma validação de data — mesma classe de bug já corrigida para reportDate/warrantyDeadlineAt
  // no ciclo 11. Fail-closed: valor inválido não pode virar NaN/Invalid Date salvo no banco.
  if (Number.isNaN(new Date(measuredAt).getTime())) {
    throw AppError.badRequest('"measuredAt" deve ser uma data válida.', 'STAGE_MEASUREMENT_VALIDATION');
  }

  // Item 3 (fechamento de gaps pós-Marco 6) — mesmo padrão de captura offline do RDO (M6-94,
  // ver dailyReports.service.js#createDailyReport): se esta `idempotencyKey` já criou uma
  // medição, devolve o registro existente em vez de duplicar (o UNIQUE parcial do banco —
  // migration 20260101000295 — é a garantia final, checamos aqui antes para devolver o
  // registro certo, não um erro de conflito genérico).
  if (idempotencyKey) {
    const existingByIdempotency = await StageMeasurement.findOne({ where: { idempotencyKey }, transaction });
    if (existingByIdempotency) {
      return existingByIdempotency;
    }
  }

  await getProjectStage(projectStageId, transaction);

  const measurement = await StageMeasurement.create(
    {
      groupId,
      companyId,
      projectStageId,
      measuredPct: numericPct,
      measuredAt,
      measuredByUserId: actorUserId || null,
      notes: notes || null,
      status: 'DRAFT',
      revisionNumber: 1,
      totalAmount: assertValidManualTotalAmount(totalAmount),
      costCenterId: costCenterId || null,
      idempotencyKey: idempotencyKey || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  if (Array.isArray(items) && items.length > 0) {
    const { totalAmount: computedTotal } = await createMeasurementItems(measurement, items, actorUserId, transaction);
    measurement.totalAmount = computedTotal;
    await measurement.save({ transaction });
  }

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'construction.stage_measurement.create',
      entityType: 'StageMeasurement',
      entityId: measurement.id,
      afterJson: measurement.toJSON(),
      reason: `Medição de ${numericPct}% registrada (DRAFT) para a etapa ${projectStageId}.`,
    },
    transaction
  );

  return measurement;
}

// BUG REAL CORRIGIDO (auditoria Marco 6, ciclo 16 — mesmo padrão do bug de listDailyReports no
// ciclo 15): listStageMeasurements devolvia TODAS as linhas da cadeia de revisões de uma etapa,
// inclusive as marcadas SUPERSEDED por reviseStageMeasurement. Como a revisão nova nasce em
// DRAFT com `measuredAt` igual/próximo da original, a ordenação por data não separa qual linha é
// a atual — o front listava a medição superada ao lado da revisão nova como se fossem duas
// medições independentes, e qualquer ação (revisar/decidir) tentada contra o id superado batia
// em STAGE_MEASUREMENT_INVALID_STATUS. Filtra fora qualquer linha cujo id apareça como
// `parentMeasurementId` de outra linha (ou seja, já foi substituída por uma revisão).
async function listStageMeasurements(projectStageId, transaction) {
  const all = await StageMeasurement.findAll({ where: { projectStageId }, order: [['measured_at', 'DESC']], transaction });
  const supersededIds = new Set(all.map((m) => m.parentMeasurementId).filter(Boolean));
  return all.filter((m) => !supersededIds.has(m.id));
}

async function listMeasurementItems(measurementId, transaction) {
  return MeasurementItem.findAll({ where: { measurementId }, order: [['created_at', 'ASC']], transaction });
}

async function getStageMeasurement(id, transaction, { lock = false } = {}) {
  // FIX (homologação 23/09/2026 — auditoria adversarial de corrida): decideStageMeasurement lia
  // a medição sem lock pessimista antes de checar status e decidir. Duas decisões concorrentes
  // sobre a mesma medição podiam ambas passar da guarda de status — quem commitasse por último
  // vencia silenciosamente. Passa `{ lock: true }` nas chamadas que transicionam estado.
  const measurement = await StageMeasurement.findByPk(id, {
    transaction,
    ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!measurement) throw AppError.notFound('Medição não encontrada.', 'STAGE_MEASUREMENT_NOT_FOUND');
  return measurement;
}

// Achado numa auditoria do cliente (30/09/2026): "os erros exibidos pro usuário alguns são em
// código ou inglês" — rótulos em português, mesmos usados nos badges da tela, em vez do enum
// cru interpolado direto na mensagem.
const MEASUREMENT_STATUS_LABELS_PT = {
  DRAFT: 'Rascunho',
  SUBMITTED: 'Enviada para revisão',
  REVIEWED: 'Revisada',
  PAYABLE: 'Aprovada',
  REJECTED: 'Rejeitada',
  SUPERSEDED: 'Substituída',
};

function assertTransition(measurement, allowedFrom, actionLabel) {
  if (!allowedFrom.includes(measurement.status)) {
    const allowedLabels = allowedFrom.map((s) => MEASUREMENT_STATUS_LABELS_PT[s] || s).join(', ');
    const currentLabel = MEASUREMENT_STATUS_LABELS_PT[measurement.status] || measurement.status;
    throw AppError.conflict(
      `Só é possível ${actionLabel} uma medição no estado "${allowedLabels}" — esta está "${currentLabel}".`,
      'STAGE_MEASUREMENT_INVALID_STATUS'
    );
  }
}

/**
 * submitStageMeasurement — DRAFT -> SUBMITTED (M6-10). Dispara o evento de domínio
 * `measurement.submitted`. A partir daqui, qualquer alteração de conteúdo passa a exigir uma
 * revisão nova (`reviseStageMeasurement`) em vez de editar esta linha.
 */
async function submitStageMeasurement(id, actorUserId, transaction) {
  const measurement = await getStageMeasurement(id, transaction, { lock: true });
  assertTransition(measurement, ['DRAFT'], 'submeter');

  const beforeJson = measurement.toJSON();
  measurement.status = 'SUBMITTED';
  measurement.submittedAt = new Date();
  measurement.updatedBy = actorUserId || null;
  await measurement.save({ transaction });

  await publishMeasurementSubmitted(measurement, transaction);

  await registrarAuditoria(
    {
      groupId: measurement.groupId,
      companyId: measurement.companyId,
      actorUserId,
      action: 'construction.stage_measurement.submit',
      entityType: 'StageMeasurement',
      entityId: measurement.id,
      beforeJson,
      afterJson: measurement.toJSON(),
      reason: `Medição ${measurement.id} submetida para revisão/aprovação.`,
    },
    transaction
  );

  return measurement;
}

/**
 * reviewStageMeasurement — SUBMITTED -> REVIEWED (M6-10). Etapa de revisão técnica antes da
 * decisão financeira final (`decideStageMeasurement`). Não tem efeito financeiro nenhum.
 */
async function reviewStageMeasurement(id, { notes } = {}, actorUserId, transaction) {
  const measurement = await getStageMeasurement(id, transaction, { lock: true });
  assertTransition(measurement, ['SUBMITTED'], 'revisar');

  const beforeJson = measurement.toJSON();
  measurement.status = 'REVIEWED';
  measurement.reviewedAt = new Date();
  measurement.reviewedByUserId = actorUserId || null;
  measurement.reviewNotes = notes || null;
  measurement.updatedBy = actorUserId || null;
  await measurement.save({ transaction });

  await registrarAuditoria(
    {
      groupId: measurement.groupId,
      companyId: measurement.companyId,
      actorUserId,
      action: 'construction.stage_measurement.review',
      entityType: 'StageMeasurement',
      entityId: measurement.id,
      beforeJson,
      afterJson: measurement.toJSON(),
      reason: `Medição ${measurement.id} revisada.`,
    },
    transaction
  );

  return measurement;
}

/**
 * reviseStageMeasurement (M6-10) — "alteração após SUBMITTED cria uma revisão nova, nunca
 * sobrescreve": só pode ser chamada quando a medição já saiu de DRAFT (SUBMITTED/REVIEWED).
 * Marca a medição atual como SUPERSEDED e cria uma nova linha em DRAFT, encadeada por
 * `parentMeasurementId`, com `revisionNumber` incrementado, recebendo os novos itens/valores.
 * A medição SUPERSEDED nunca é apagada — fica como histórico read-only.
 */
async function reviseStageMeasurement(id, payload, actorUserId, transaction) {
  const original = await getStageMeasurement(id, transaction, { lock: true });
  assertTransition(original, ['SUBMITTED', 'REVIEWED'], 'revisar/corrigir (nova revisão de)');

  const { measuredPct, measuredAt, notes, items, totalAmount } = payload || {};
  const numericPct = measuredPct !== undefined && measuredPct !== null ? Number(measuredPct) : Number(original.measuredPct);
  if (!Number.isFinite(numericPct) || numericPct < 0 || numericPct > 100) {
    throw AppError.badRequest('"measuredPct" deve ser um número entre 0 e 100.', 'STAGE_MEASUREMENT_VALIDATION');
  }
  // BUG REAL CORRIGIDO (auditoria Marco 6, ciclo 12): mesma validação de "measuredAt" ausente em
  // createStageMeasurement — aqui o campo é opcional (cai no valor original quando omitido), mas
  // quando informado também nunca era checado antes do create().
  if (measuredAt !== undefined && measuredAt !== null && Number.isNaN(new Date(measuredAt).getTime())) {
    throw AppError.badRequest('"measuredAt" deve ser uma data válida.', 'STAGE_MEASUREMENT_VALIDATION');
  }

  const beforeJson = original.toJSON();
  original.status = 'SUPERSEDED';
  original.updatedBy = actorUserId || null;
  await original.save({ transaction });

  const revision = await StageMeasurement.create(
    {
      groupId: original.groupId,
      companyId: original.companyId,
      projectStageId: original.projectStageId,
      measuredPct: numericPct,
      measuredAt: measuredAt || original.measuredAt,
      measuredByUserId: actorUserId || original.measuredByUserId,
      notes: notes !== undefined ? notes : original.notes,
      status: 'DRAFT',
      parentMeasurementId: original.id,
      revisionNumber: original.revisionNumber + 1,
      totalAmount: assertValidManualTotalAmount(totalAmount),
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  if (Array.isArray(items) && items.length > 0) {
    const { totalAmount: computedTotal } = await createMeasurementItems(revision, items, actorUserId, transaction);
    revision.totalAmount = computedTotal;
    await revision.save({ transaction });
  }

  await registrarAuditoria(
    {
      groupId: original.groupId,
      companyId: original.companyId,
      actorUserId,
      action: 'construction.stage_measurement.revise',
      entityType: 'StageMeasurement',
      entityId: original.id,
      beforeJson,
      afterJson: { superseded: original.toJSON(), revision: revision.toJSON() },
      reason: `Medição ${original.id} superada pela revisão ${revision.id} (rev. ${revision.revisionNumber}).`,
    },
    transaction
  );

  return revision;
}

/**
 * createPayableForMeasurement (M6-55/M6-68/M6-85 — O NÚCLEO DA INTEGRAÇÃO) — cria a obrigação
 * financeira (conta a pagar) correspondente a uma medição aprovada, chamando o service REAL do
 * Financeiro (financialEntriesService.createFinancialEntry — nenhum financeiro paralelo/fake).
 *
 * IDEMPOTÊNCIA (M6-55/M6-68): usa o MESMO mecanismo de idempotência já usado em todo o módulo
 * Financeiro — `idempotency_key` UNIQUE em finance.financial_entries — derivada
 * deterministicamente do id da medição (`measurement.payable:<measurementId>`). Aprovar a MESMA
 * medição duas vezes (reprocessamento de evento, duplo clique, corrida) NUNCA cria duas contas
 * a pagar:
 *   1º caminho de defesa: lock pessimista em `getStageMeasurement(..., { lock: true })` —
 *      decideStageMeasurement já trava a linha da medição antes de checar o status, então a
 *      segunda chamada concorrente só enxerga a medição já fora de [SUBMITTED, REVIEWED] e
 *      falha com STAGE_MEASUREMENT_INVALID_STATUS antes de sequer tentar criar o lançamento.
 *   2º caminho de defesa (cinto e suspensório): mesmo que os dois caminhos cheguem aqui (ex.:
 *      dados corrompidos/bug futuro que rompa o lock), a UNIQUE constraint do banco em
 *      `idempotency_key` faz o segundo INSERT falhar — `assertNoDuplicatePayment` dentro de
 *      `createFinancialEntry` intercepta isso e devolve um erro de negócio claro
 *      (FINANCE_DUPLICATE_PAYMENT) em vez de estourar como erro de constraint cru.
 *
 * M6-97 — carrega `constructionProjectId` como dimensão no lançamento, permitindo relatório de
 * margem por obra sem heurística.
 */
async function createPayableForMeasurement(measurement, actorUserId, transaction) {
  const stage = await getProjectStage(measurement.projectStageId, transaction);
  const project = await Project.findByPk(stage.projectId, { transaction });

  // M6-97 (reforço — achado em nova rodada de verificação de integrações, 30/09/2026, fail-
  // closed desde 2026-10-07): a obrigação gerada aqui é uma despesa (DEBIT/PAYABLE) — resolve
  // o centro de custo da medição (override pontual) ou, na ausência, o centro de custo padrão
  // da obra; se nenhum dos dois estiver configurado, usa (criando se necessário) um centro de
  // custo padrão para medições de obra — createFinancialEntry agora é fail-closed e nunca mais
  // aceita PAYABLE sem costCenterId.
  let resolvedCostCenterId = measurement.costCenterId || (project ? project.costCenterId : null) || null;
  if (!resolvedCostCenterId) {
    const defaultCostCenter = await getOrCreateDefaultCostCenter(
      measurement.groupId,
      measurement.companyId,
      MEASUREMENT_COST_CENTER_CODE,
      'Obras — medições',
      transaction
    );
    resolvedCostCenterId = defaultCostCenter.id;
  }

  const entry = await financialEntriesService.createFinancialEntry(
    {
      groupId: measurement.groupId,
      companyId: measurement.companyId,
      entryType: 'DEBIT',
      nature: 'PAYABLE',
      amount: measurement.totalAmount,
      description: `Medição aprovada — etapa "${stage.name}" (medição ${measurement.id})`,
      idempotencyKey: `measurement.payable:${measurement.id}`,
      constructionProjectId: project ? project.id : stage.projectId,
      costCenterId: resolvedCostCenterId,
    },
    actorUserId,
    transaction
  );

  return entry;
}

/**
 * decideStageMeasurement — decide uma medição em SUBMITTED ou REVIEWED (M6-10/M6-21).
 *   APPROVED: propaga measuredPct para project_stages.measured_pct, cria a obrigação financeira
 *     (createPayableForMeasurement) e, na MESMA transação, avança o status para PAYABLE — uma
 *     medição aprovada sem lançamento financeiro nunca fica visível como "aprovada" (bug #5 do
 *     Marco 6 corrigido: medição aprovada SEMPRE gera obrigação financeira).
 *   REJECTED: estado terminal, exige `rejectionReason`.
 */
async function decideStageMeasurement(id, { decision, rejectionReason }, actorUserId, transaction) {
  const measurement = await getStageMeasurement(id, transaction, { lock: true });
  // BUG REAL CORRIGIDO (auditoria do cliente, Marco 6, achado ao vivo): decideStageMeasurement
  // aceitava APPROVED direto de SUBMITTED, pulando a etapa de revisão técnica (reviewStageMeasurement)
  // — o front escondia o botão "Aprovar" em SUBMITTED, mas quem chamasse a API direto (Postman/
  // integração) aprovava sem revisão nenhuma, com efeito financeiro real (createPayableForMeasurement).
  // Fail-closed também no backend: REJECTED pode vir de SUBMITTED ou REVIEWED (rejeitar não exige
  // ter sido revisada antes), mas APPROVED só é aceito a partir de REVIEWED.
  assertTransition(measurement, ['SUBMITTED', 'REVIEWED'], 'decidir');

  const normalizedDecision = String(decision || '').toUpperCase();
  if (!['APPROVED', 'REJECTED'].includes(normalizedDecision)) {
    throw AppError.badRequest('A decisão precisa ser "aprovar" ou "rejeitar".', 'STAGE_MEASUREMENT_DECISION_INVALID');
  }

  if (normalizedDecision === 'APPROVED' && measurement.status !== 'REVIEWED') {
    throw AppError.conflict(
      'Só é possível aprovar uma medição que já foi revisada ("Revisada") — esta ainda está "Enviada para revisão". Revise antes de aprovar.',
      'STAGE_MEASUREMENT_REVIEW_REQUIRED'
    );
  }

  const beforeJson = measurement.toJSON();

  if (normalizedDecision === 'REJECTED') {
    measurement.status = 'REJECTED';
    measurement.approvedByUserId = actorUserId || null;
    measurement.decidedAt = new Date();
    measurement.rejectionReason = rejectionReason || null;
    measurement.updatedBy = actorUserId || null;
    await measurement.save({ transaction });

    await publishStageMeasurementDecided(measurement, transaction);

    await registrarAuditoria(
      {
        groupId: measurement.groupId,
        companyId: measurement.companyId,
        actorUserId,
        action: 'construction.stage_measurement.decide',
        entityType: 'StageMeasurement',
        entityId: measurement.id,
        beforeJson,
        afterJson: measurement.toJSON(),
        reason: `Medição ${measurement.id} rejeitada.`,
      },
      transaction
    );

    return measurement;
  }

  // APPROVED — exige valor definido: sem isso não há o que faturar (M6-11/M6-55).
  if (
    measurement.totalAmount === null ||
    measurement.totalAmount === undefined ||
    !Number.isFinite(Number(measurement.totalAmount)) ||
    Number(measurement.totalAmount) <= 0
  ) {
    throw AppError.badRequest(
      'Não é possível aprovar uma medição sem "totalAmount" (adicione itens de medição ou informe o valor total antes de aprovar).',
      'STAGE_MEASUREMENT_MISSING_AMOUNT'
    );
  }

  measurement.status = 'APPROVED';
  measurement.approvedByUserId = actorUserId || null;
  measurement.approvedAt = new Date();
  measurement.decidedAt = new Date();
  measurement.updatedBy = actorUserId || null;
  await measurement.save({ transaction });

  const stage = await getProjectStage(measurement.projectStageId, transaction);
  stage.measuredPct = measurement.measuredPct;
  // FIX (auditoria E2E de browser, ciclo 4, 02/10/2026): aprovar uma medição de 100% nunca
  // completava a etapa (status ficava para sempre "Pendente"/"Em andamento") — nada aqui setava
  // status DONE. Consequência real: uma etapa dependente nunca consegue enxergar a predecessora
  // como concluída, travando o fluxo de dependências indefinidamente mesmo com a obra 100%
  // medida e paga. Decisão de engenharia (sem detalhe explícito na fonte sobre o gatilho exato):
  // medição 100% APROVADA é o sinal mais forte disponível de etapa fisicamente concluída.
  const stageBeforeJson = stage.toJSON();
  const stageCompletedNow = Number(stage.measuredPct) >= 100 && stage.status !== 'DONE';
  if (stageCompletedNow) {
    stage.status = 'DONE';
  }
  stage.updatedBy = actorUserId || null;
  await stage.save({ transaction });

  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 18, 2026-10-05): a conclusão
  // automática da etapa (ciclo 4) mutava `stage.status` direto, por fora de
  // `updateProjectStage` — o único lugar que de fato dispara `project.stage.completed` (M6-106,
  // evento canônico documentado em constructionEvents.service.js que Financeiro/BI esperam no
  // barramento) e audita a transição da ProjectStage. Completar a etapa por aprovação de
  // medição de 100% é exatamente o caminho real de negócio — precisa dos mesmos efeitos que um
  // PATCH manual de status já tinha.
  if (stageCompletedNow) {
    await publishStageCompleted(stage, transaction);
    await registrarAuditoria(
      {
        groupId: stage.groupId,
        companyId: stage.companyId,
        actorUserId,
        action: 'construction.stage.update',
        entityType: 'ProjectStage',
        entityId: stage.id,
        beforeJson: stageBeforeJson,
        afterJson: stage.toJSON(),
        reason: 'Etapa concluída automaticamente por aprovação de medição em 100%.',
      },
      transaction
    );
  }

  const financialEntry = await createPayableForMeasurement(measurement, actorUserId, transaction);

  measurement.status = 'PAYABLE';
  measurement.payableFinancialEntryId = financialEntry.id;
  measurement.updatedBy = actorUserId || null;
  await measurement.save({ transaction });

  await publishMeasurementApproved(measurement, transaction);
  await publishStageMeasurementDecided(measurement, transaction);

  await registrarAuditoria(
    {
      groupId: measurement.groupId,
      companyId: measurement.companyId,
      actorUserId,
      action: 'construction.stage_measurement.decide',
      entityType: 'StageMeasurement',
      entityId: measurement.id,
      beforeJson,
      afterJson: measurement.toJSON(),
      reason: `Medição ${measurement.id} aprovada — obrigação financeira ${financialEntry.id} criada (${measurement.totalAmount}).`,
    },
    transaction
  );

  return measurement;
}

module.exports = {
  createStageMeasurement,
  listStageMeasurements,
  listMeasurementItems,
  getStageMeasurement,
  submitStageMeasurement,
  reviewStageMeasurement,
  reviseStageMeasurement,
  decideStageMeasurement,
  createPayableForMeasurement,
  STATUSES,
};
