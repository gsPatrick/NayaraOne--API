'use strict';

const { QualityChecklistItem } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { createNonconformity } = require('./nonconformities.service');

// DECISÃO DE ENGENHARIA (M6-12): categorias fixas escolhidas a partir dos ofícios de obra mais
// comuns (lista não documentada na fonte — ver comentário da migration
// 20260101000219-add-category-to-quality_checklist_items.js). Mantém o item como campo livre
// (texto da verificação específica), mas classifica o TIPO do item, saindo do "texto livre
// puro" anterior.
const CATEGORIES = ['PINTURA', 'HIDRAULICA', 'ELETRICA', 'ESTRUTURA', 'ACABAMENTO', 'ALVENARIA', 'OUTROS'];

async function createQualityItem(projectId, payload, actorUserId, transaction) {
  const { groupId, companyId, projectStageId, item, category } = payload;
  if (!groupId || !companyId || !item) {
    throw AppError.badRequest('Os campos "groupId", "companyId" e "item" são obrigatórios.', 'QUALITY_ITEM_VALIDATION');
  }
  const normalizedCategory = category ? String(category).toUpperCase() : 'OUTROS';
  if (!CATEGORIES.includes(normalizedCategory)) {
    throw AppError.badRequest(`"category" deve ser um de: ${CATEGORIES.join(', ')}.`, 'QUALITY_ITEM_CATEGORY_INVALID');
  }

  const checklistItem = await QualityChecklistItem.create(
    {
      groupId,
      companyId,
      projectId,
      projectStageId: projectStageId || null,
      item,
      category: normalizedCategory,
      status: 'PENDING',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'construction.quality_item.create',
      entityType: 'QualityChecklistItem',
      entityId: checklistItem.id,
      afterJson: checklistItem.toJSON(),
      reason: `Item de qualidade "${item}" criado para a obra ${projectId}.`,
    },
    transaction
  );

  return checklistItem;
}

async function listQualityItems(projectId, transaction) {
  return QualityChecklistItem.findAll({ where: { projectId }, order: [['created_at', 'ASC']], transaction });
}

async function getQualityItem(id, transaction) {
  const item = await QualityChecklistItem.findByPk(id, { transaction });
  if (!item) throw AppError.notFound('Item de qualidade não encontrado.', 'QUALITY_ITEM_NOT_FOUND');
  return item;
}

const CHECK_STATUSES = ['PENDING', 'OK', 'NOT_OK'];
const CHECK_STATUS_LABELS_PT = { PENDING: 'Pendente', OK: 'OK', NOT_OK: 'Não conforme' };

// BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 60, 2026-10-06): a NC aberta
// automaticamente ao reprovar um item NOT_OK sempre tinha severity hardcoded 'MEDIUM' — como o
// gate de entrega (hasOpenCriticalNonconformity em projects.service.js) só bloqueia NC
// status=OPEN AND severity=CRITICAL, NENHUMA reprovação de checklist de qualidade jamais
// bloqueava a entrega da obra, mesmo pra categorias estruturais/hidráulicas/elétricas — o "elo"
// entre o checklist e o gate de entrega (M6-25) estava quebrado por um valor fixo.
const CRITICAL_QUALITY_CATEGORIES = ['ESTRUTURA', 'HIDRAULICA', 'ELETRICA'];
function severityForQualityCategory(category) {
  return CRITICAL_QUALITY_CATEGORIES.includes(category) ? 'CRITICAL' : 'MEDIUM';
}

async function checkQualityItem(id, { status, notes, evidenceFileIds, responsibleUserId }, actorUserId, transaction) {
  // BUG REAL CORRIGIDO (rodada 42): sem lock, duplo clique/corrida concorrente podia abrir duas
  // Nonconformity pro mesmo item NOT_OK (R19).
  const item = await QualityChecklistItem.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!item) throw AppError.notFound('Item de qualidade não encontrado.', 'QUALITY_ITEM_NOT_FOUND');
  const normalizedStatus = String(status || '').toUpperCase();
  if (!CHECK_STATUSES.includes(normalizedStatus)) {
    throw AppError.badRequest(
      `"status" deve ser um de: ${CHECK_STATUSES.map((s) => CHECK_STATUS_LABELS_PT[s]).join(', ')}.`,
      'QUALITY_ITEM_STATUS_INVALID'
    );
  }

  const beforeJson = item.toJSON();
  const previousStatus = item.status;
  item.status = normalizedStatus;
  item.notes = notes !== undefined ? notes : item.notes;
  item.checkedByUserId = actorUserId || null;
  item.checkedAt = new Date();
  item.updatedBy = actorUserId || null;
  await item.save({ transaction });

  await registrarAuditoria(
    {
      groupId: item.groupId,
      companyId: item.companyId,
      actorUserId,
      action: 'construction.quality_item.check',
      entityType: 'QualityChecklistItem',
      entityId: item.id,
      beforeJson,
      afterJson: item.toJSON(),
      reason: `Item de qualidade "${item.item}" marcado como "${normalizedStatus}".`,
    },
    transaction
  );

  // BUG REAL CORRIGIDO (auditoria "loop até secar", rodada 19, 2026-10-05): o contrato diz
  // literalmente "falha abre nonconformity" — mas marcar um item NOT_OK só gravava o status do
  // item, sem nenhum vínculo automático com Nonconformity. O gate de entrega
  // (PROJECT_DELIVERY_BLOCKED_BY_CRITICAL_NONCONFORMITY em projects.service.js) só bloqueia NC
  // já aberta — se ninguém abrisse manualmente, uma obra com item de qualidade reprovado
  // conhecido podia ser entregue sem registro formal nenhum da falha.
  //
  // BUG REAL CORRIGIDO (auditoria Marco 6, ciclo 4, 2026-10-06): a condição original disparava
  // em TODA chamada com status=NOT_OK, mesmo quando o item já estava NOT_OK antes (re-check
  // sequencial, não concorrente — o lock da rodada 42 só protege contra corrida simultânea, não
  // contra chamadas repetidas em sequência). Reenviar o mesmo PATCH/POST de "check" duas vezes
  // (duplo clique sem debounce no front, retry de rede, reenvio manual) abria uma segunda
  // Nonconformity CRITICAL duplicada para o MESMO item reprovado — como QualityChecklistItem não
  // guarda nenhum vínculo de volta para a Nonconformity criada (sem FK), essas duplicatas nunca
  // eram fechadas junto e ficavam para sempre bloqueando o gate de entrega
  // (hasOpenCriticalNonconformity) mesmo depois de uma delas ser fechada. Só abre NC nova quando
  // o item está TRANSICIONANDO para NOT_OK (de PENDING/OK) — reafirmar um item que já está
  // NOT_OK não duplica o registro.
  // BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-07): a abertura automática de NC a
  // partir de um item de qualidade reprovado não coletava responsável nem evidência "antes" —
  // createNonconformity agora exige os dois (contrato, invariante "Não conformidade exige
  // severidade, responsável, SLA, evidência antes/depois..."). Reaproveita quem está marcando o
  // item (actorUserId) como responsável por padrão, e exige evidência de verdade: quem reprova
  // um item agora precisa anexar ao menos uma foto/arquivo, assim como já é exigido em todo
  // outro fluxo de abertura de NC (tela de Qualidade).
  if (normalizedStatus === 'NOT_OK' && previousStatus !== 'NOT_OK') {
    const resolvedEvidenceFileIds = Array.isArray(evidenceFileIds) ? evidenceFileIds.filter(Boolean) : [];
    if (resolvedEvidenceFileIds.length === 0) {
      throw AppError.badRequest(
        'Reprovar um item de qualidade exige ao menos uma evidência ("evidenceFileIds") — a reprovação abre automaticamente uma não conformidade.',
        'QUALITY_ITEM_EVIDENCE_REQUIRED'
      );
    }
    await createNonconformity(
      item.projectId,
      {
        groupId: item.groupId,
        companyId: item.companyId,
        projectStageId: item.projectStageId,
        severity: severityForQualityCategory(item.category),
        description: `Checklist de qualidade reprovado: "${item.item}"${notes ? ` — ${notes}` : ''}.`,
        responsibleUserId: responsibleUserId || actorUserId,
        beforeEvidenceFileIds: resolvedEvidenceFileIds,
      },
      actorUserId,
      transaction
    );
  }

  return item;
}

// LACUNA REAL CORRIGIDA (auditoria Marco 6, Ciclo 9): havia create+check para
// QualityChecklistItem, mas nenhuma forma de remover um item de checklist cadastrado por
// engano (categoria/texto errado) antes de qualquer verificação — só dava pra "resolver"
// marcando OK/NOT_OK, poluindo o checklist real da obra para sempre. Só permite excluir
// enquanto o item ainda está PENDING (sem check nenhum registrado) — depois de checado, o
// registro já tem valor de auditoria/histórico e não pode mais ser removido (mesma régua já
// usada em BudgetLine: remoção só antes do fato gerador ficar definitivo).
async function removeQualityItem(id, actorUserId, transaction) {
  const item = await QualityChecklistItem.findByPk(id, { transaction, lock: transaction?.LOCK?.UPDATE });
  if (!item) throw AppError.notFound('Item de qualidade não encontrado.', 'QUALITY_ITEM_NOT_FOUND');
  if (item.status !== 'PENDING') {
    throw AppError.conflict(
      'Só é possível excluir um item de checklist ainda não verificado (status "Pendente").',
      'QUALITY_ITEM_NOT_DELETABLE'
    );
  }

  const beforeJson = item.toJSON();
  item.deletedBy = actorUserId || null;
  await item.save({ transaction });
  await item.destroy({ transaction });

  await registrarAuditoria(
    {
      groupId: item.groupId,
      companyId: item.companyId,
      actorUserId,
      action: 'construction.quality_item.delete',
      entityType: 'QualityChecklistItem',
      entityId: item.id,
      beforeJson,
      reason: `Item de qualidade "${item.item}" excluído antes de qualquer verificação.`,
    },
    transaction
  );

  return { id };
}

module.exports = { createQualityItem, listQualityItems, getQualityItem, checkQualityItem, removeQualityItem, CATEGORIES };
