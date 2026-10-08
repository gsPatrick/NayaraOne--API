'use strict';

const { Op } = require('sequelize');
const { sequelize, AiRun, AiRecommendation, InventoryItem, Project } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { getSetting } = require('../settings/settings.service');
const procurementService = require('../procurement/procurement.service');

/**
 * NAY Estoque — componente nomeado da NAY para o módulo de Estoque (Marco 7).
 *
 * Contrato bruto:
 *   EST-013: "NAY pode sugerir compra, risco de falta ou anomalia, mas não efetiva compra/baixa
 *            sozinha."
 *   §12:     "NAY pode sugerir compra baseada em consumo, obras ativas, lead time e estoque.
 *            Sugestão não cria pedido de compra sem workflow autorizado."
 *   EST-TS-14: "IA sugere culpa [em loss_case] -> Sem efeito financeiro."
 *
 * MESMA DECISÃO DE ENGENHARIA de construction/nayObras.service.js (template deste arquivo): o
 * projeto não tem NENHUMA integração de LLM/IA generativa contratada. Em vez de fingir
 * inferência probabilística, a NAY Estoque é RULE-BASED/determinística sobre dados reais do
 * banco (movimentos, saldos, requisições de obra, histórico de compras e casos de perda) — cada
 * sugestão carrega os sinais exatos e as razões em texto que a produziram (`payloadJson`),
 * então qualquer humano consegue auditar por que ela existe.
 *
 * Armazenamento: reusa a infraestrutura compartilhada da NAY (schema "ai", migrations 67/70) em
 * vez de criar tabela nova — "ai"."ai_runs" registra cada execução (auditoria de orquestração)
 * e "ai"."ai_recommendations" guarda cada sugestão de compra (relatedEntityType =
 * 'inventory.inventory_items', status PENDING -> ACCEPTED | REJECTED | EXPIRED). O status
 * AUTO_APPLIED previsto no modelo NUNCA é usado aqui: nenhuma sugestão se aplica sozinha.
 *
 * Fronteira "sugere, nunca decide" (EST-013/§12), garantida por construção:
 *   - generatePurchaseSuggestions/analyzeLossCaseAnomalies NUNCA chamam createPurchaseRequest,
 *     recordMovement, decideLossCase nem nada financeiro — só leem e gravam no schema "ai".
 *   - approvePurchaseSuggestion é o ÚNICO caminho que chama procurement.createPurchaseRequest,
 *     e só é acionado por uma ação humana explícita (rota protegida por procurement:create —
 *     a mesma permissão de quem abre uma requisição de compra manualmente). Mesmo então, o
 *     que nasce é uma requisição REQUESTED, que ainda passa pelo workflow de aprovação de
 *     compras já existente (decidePurchaseRequest) antes de qualquer cotação/pedido — é esse o
 *     "workflow autorizado" do §12.
 */

const AGENT_NAME = 'NAY_ESTOQUE';
const COMPONENT_NAME = 'NAY Estoque';
const RECOMMENDATION_TYPE_PURCHASE = 'INVENTORY_PURCHASE_SUGGESTION';
const RELATED_ENTITY_ITEM = 'inventory.inventory_items';

const DEFAULT_WINDOW_DAYS = 90;
const MIN_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 365;
// Lead time de último recurso, só quando não há histórico real de reposição do item nem
// configuração do tenant ('inventory.nay_default_lead_time_days'). A sugestão sempre informa
// qual fonte foi usada (leadTimeSource), nunca apresenta o padrão como se fosse medido.
const FALLBACK_LEAD_TIME_DAYS = 7;
// Quantos recebimentos mais recentes do item entram na mediana de lead time observado.
const OBSERVED_LEAD_TIME_SAMPLE = 5;
// Cobertura alvo depois da reposição: além de atravessar o lead time, a compra sugerida cobre
// mais este período de consumo (ciclo de revisão), pra não gerar sugestão nova toda semana.
const REVIEW_PERIOD_DAYS = 30;
// "Obras ativas" (projects.service.js, Caderno "4. Estados da obra"): em execução ou pausada
// (pode retomar a qualquer momento) ou em vistoria final (ainda pode consumir material).
const ACTIVE_PROJECT_STATUSES = ['ACTIVE', 'PAUSED', 'FINAL_INSPECTION'];
// Depois que um humano REJEITA a sugestão de um item/local, a NAY não a recria a cada
// recálculo por este período — a menos que o risco tenha escalado para HIGH (risco de falta)
// e a rejeitada não fosse HIGH. A decisão humana pesa mais que a insistência da sugestão.
const REJECTION_COOLDOWN_DAYS = 7;

// Anomalias em loss_cases (EST-TS-14).
const RECURRENCE_MIN_CASES = 3;
const VALUE_ANOMALY_FACTOR = 2;
const VALUE_HISTORY_DAYS = 365;
const VALUE_HISTORY_MIN_SAMPLES = 2;

function round4(value) {
  return Math.round(Number(value) * 10000) / 10000;
}
function ceil2(value) {
  return Math.ceil(Number(value) * 100 - 1e-9) / 100;
}
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function resolveWindowDays(windowDays) {
  if (windowDays == null || windowDays === '') return DEFAULT_WINDOW_DAYS;
  const n = Number(windowDays);
  if (!Number.isInteger(n) || n < MIN_WINDOW_DAYS || n > MAX_WINDOW_DAYS) {
    throw AppError.badRequest(
      `"windowDays" precisa ser um inteiro entre ${MIN_WINDOW_DAYS} e ${MAX_WINDOW_DAYS}.`,
      'INVENTORY_NAY_VALIDATION'
    );
  }
  return n;
}

function keyOf(itemId, locationId) {
  return `${itemId}|${locationId}`;
}

// --- Sinais (somente leitura) -------------------------------------------------------------

async function loadCandidateBalances({ companyId, inventoryItemId, locationId }, transaction) {
  // Compra repõe almoxarifado (WAREHOUSE): canteiro de obra é abastecido por requisição a partir
  // do almoxarifado, não por compra direta — por isso só saldos de WAREHOUSE são candidatos.
  // Só CONSUMABLE: ferramenta/patrimônio é controlado por asset (Guia §6), não por reposição.
  // Limitação conhecida: o par item/almoxarifado só existe depois do primeiro movimento ali
  // (stock_balances). Item com mínimo que nunca entrou em nenhum almoxarifado não tem local
  // definido pra repor — não há como sugerir onde comprar, então não é candidato.
  const filters = [];
  const replacements = { companyId };
  if (inventoryItemId) {
    filters.push('AND sb.inventory_item_id = :inventoryItemId');
    replacements.inventoryItemId = inventoryItemId;
  }
  if (locationId) {
    filters.push('AND sb.location_id = :locationId');
    replacements.locationId = locationId;
  }
  return sequelize.query(
    `SELECT sb.inventory_item_id AS "inventoryItemId", sb.location_id AS "locationId",
            sb.quantity_on_hand AS "quantityOnHand",
            i.name AS "itemName", i.sku AS "sku", i.unit_of_measure AS "unitOfMeasure",
            i.minimum_quantity AS "minimumQuantity", i.average_cost AS "averageCost",
            l.name AS "locationName"
       FROM inventory.stock_balances sb
       JOIN inventory.inventory_items i ON i.id = sb.inventory_item_id AND i.deleted_at IS NULL
       JOIN inventory.locations l ON l.id = sb.location_id AND l.deleted_at IS NULL
      WHERE sb.company_id = :companyId
        AND i.status = 'ACTIVE' AND i.item_type = 'CONSUMABLE'
        AND l.location_type = 'WAREHOUSE' AND l.is_active = true
        ${filters.join(' ')}`,
    { replacements, type: sequelize.QueryTypes.SELECT, transaction }
  );
}

async function loadConsumption({ companyId, since }, transaction) {
  // Consumo = saídas (OUT) a partir do local, na janela. TRANSFER não é consumo (só muda de
  // lugar) e LOSS/DISPOSAL não é demanda planejada (é exceção — vai pra anomalia, não pra compra).
  const rows = await sequelize.query(
    `SELECT inventory_item_id AS "inventoryItemId", source_location_id AS "locationId",
            SUM(ABS(quantity)) AS "consumed", COUNT(*) AS "movementCount"
       FROM inventory.inventory_movements
      WHERE company_id = :companyId AND movement_type = 'OUT'
        AND source_location_id IS NOT NULL
        AND COALESCE(moved_at, created_at) >= :since
      GROUP BY inventory_item_id, source_location_id`,
    { replacements: { companyId, since }, type: sequelize.QueryTypes.SELECT, transaction }
  );
  const map = new Map();
  for (const r of rows) map.set(keyOf(r.inventoryItemId, r.locationId), { consumed: Number(r.consumed), movementCount: Number(r.movementCount) });
  return map;
}

async function loadActiveProjectDemand({ companyId, since }, transaction) {
  // Obras ativas consumindo o item: requisições recentes (não rejeitadas) de obras em
  // ACTIVE_PROJECT_STATUSES saindo do almoxarifado. A parte ainda não baixada (REQUESTED/
  // APPROVED, quantity - issued_quantity) é demanda comprometida que AINDA não virou OUT — por
  // isso entra na projeção de saldo sem dupla contagem com o consumo histórico.
  const rows = await sequelize.query(
    `SELECT ri.inventory_item_id AS "inventoryItemId", r.warehouse_location_id AS "locationId",
            r.project_id AS "projectId", p.name AS "projectName", p.code AS "projectCode", p.status AS "projectStatus",
            SUM(ri.quantity) AS "requestedQuantity",
            SUM(CASE WHEN r.status IN ('REQUESTED', 'APPROVED') THEN GREATEST(ri.quantity - ri.issued_quantity, 0) ELSE 0 END) AS "pendingQuantity"
       FROM inventory.requisitions r
       JOIN inventory.requisition_items ri ON ri.requisition_id = r.id
       JOIN construction.projects p ON p.id = r.project_id AND p.deleted_at IS NULL
      WHERE r.company_id = :companyId AND r.status <> 'REJECTED'
        -- Pendentes (REQUESTED/APPROVED) contam mesmo se abertas antes da janela: ainda são
        -- demanda comprometida. A janela só limita o histórico já baixado (ISSUED).
        AND (r.created_at >= :since OR r.status IN ('REQUESTED', 'APPROVED'))
        AND p.status IN (:statuses)
      GROUP BY ri.inventory_item_id, r.warehouse_location_id, r.project_id, p.name, p.code, p.status`,
    { replacements: { companyId, since, statuses: ACTIVE_PROJECT_STATUSES }, type: sequelize.QueryTypes.SELECT, transaction }
  );
  const map = new Map();
  for (const r of rows) {
    const key = keyOf(r.inventoryItemId, r.locationId);
    if (!map.has(key)) map.set(key, { pendingQuantity: 0, projects: [] });
    const entry = map.get(key);
    entry.pendingQuantity += Number(r.pendingQuantity);
    entry.projects.push({
      projectId: r.projectId,
      name: r.projectName,
      code: r.projectCode,
      status: r.projectStatus,
      requestedQuantity: round4(r.requestedQuantity),
      pendingQuantity: round4(r.pendingQuantity),
    });
  }
  return map;
}

async function loadObservedLeadTimes({ companyId, itemIds }, transaction) {
  // Lead time OBSERVADO: tempo real entre o pedido de compra (purchase_orders.created_at) e o
  // recebimento físico (goods_receipts.created_at) do item — dado de verdade do próprio fluxo
  // de Compras, não um número digitado. Mediana dos últimos OBSERVED_LEAD_TIME_SAMPLE.
  const map = new Map();
  if (!itemIds.length) return map;
  const rows = await sequelize.query(
    `SELECT poi.inventory_item_id AS "inventoryItemId",
            EXTRACT(EPOCH FROM (gr.created_at - po.created_at)) / 86400.0 AS "days"
       FROM procurement.goods_receipt_items gri
       JOIN procurement.goods_receipts gr ON gr.id = gri.goods_receipt_id
       JOIN procurement.purchase_order_items poi ON poi.id = gri.purchase_order_item_id
       JOIN procurement.purchase_orders po ON po.id = gr.purchase_order_id
      WHERE gr.company_id = :companyId AND poi.inventory_item_id IN (:itemIds)
      ORDER BY gr.created_at DESC`,
    { replacements: { companyId, itemIds }, type: sequelize.QueryTypes.SELECT, transaction }
  );
  const samples = new Map();
  for (const r of rows) {
    const list = samples.get(r.inventoryItemId) || [];
    if (list.length < OBSERVED_LEAD_TIME_SAMPLE) list.push(Math.max(0, Number(r.days)));
    samples.set(r.inventoryItemId, list);
  }
  for (const [itemId, list] of samples) {
    // Dia inteiro mais próximo: segundos/minutos de diferença entre pedido e recebimento não
    // podem inflar o prazo em um dia inteiro (ceil transformaria 12d+5s em 13d).
    map.set(itemId, { days: Math.round(median(list)), sampleSize: list.length });
  }
  return map;
}

async function resolveDefaultLeadTime(tenant, transaction) {
  const configured = await getSetting('inventory.nay_default_lead_time_days', tenant, transaction, null);
  if (configured != null && Number.isInteger(Number(configured)) && Number(configured) >= 0) {
    return { days: Number(configured), source: 'TENANT_SETTING' };
  }
  return { days: FALLBACK_LEAD_TIME_DAYS, source: 'DEFAULT' };
}

/**
 * computePurchaseSignals — núcleo determinístico (puro, sem I/O) que transforma os sinais de um
 * par item/local numa sugestão (ou null). Exportado para teste unitário direto da regra.
 */
function computePurchaseSignals({ quantityOnHand, minimumQuantity, consumed, windowDays, leadTimeDays, pendingQuantity }) {
  const onHand = Number(quantityOnHand) || 0;
  const hasThreshold = minimumQuantity != null && Number(minimumQuantity) > 0;
  const threshold = hasThreshold ? Number(minimumQuantity) : 0;
  const dailyRate = (Number(consumed) || 0) / windowDays;
  const pending = Number(pendingQuantity) || 0;
  const projectedOnHand = onHand - pending;
  const reorderPoint = threshold + dailyRate * leadTimeDays;

  // Sem nenhum sinal de demanda (sem mínimo, sem consumo, sem obra pedindo) não há base pra
  // sugerir nada — não inventa necessidade.
  if (!hasThreshold && dailyRate <= 0 && pending <= 0) return null;
  if (projectedOnHand > reorderPoint) return null;

  const targetLevel = threshold + dailyRate * (leadTimeDays + REVIEW_PERIOD_DAYS);
  const suggestedQuantity = ceil2(targetLevel - projectedOnHand);
  if (!(suggestedQuantity > 0)) return null;

  const daysOfCoverage = dailyRate > 0 ? round4(Math.max(projectedOnHand, 0) / dailyRate) : null;
  let riskLevel = 'LOW';
  if (projectedOnHand <= 0 || (daysOfCoverage !== null && daysOfCoverage < leadTimeDays)) riskLevel = 'HIGH';
  else if (hasThreshold && projectedOnHand <= threshold) riskLevel = 'MEDIUM';

  return {
    quantityOnHand: round4(onHand),
    pendingProjectDemand: round4(pending),
    projectedOnHand: round4(projectedOnHand),
    minimumQuantity: hasThreshold ? round4(threshold) : null,
    consumedInWindow: round4(Number(consumed) || 0),
    dailyConsumptionRate: round4(dailyRate),
    leadTimeDays,
    reorderPoint: round4(reorderPoint),
    targetLevel: round4(targetLevel),
    daysOfCoverage,
    suggestedQuantity,
    riskLevel,
    stockoutRisk: riskLevel === 'HIGH',
  };
}

function buildReasons(signals, ctx) {
  const reasons = [];
  if (signals.consumedInWindow > 0) {
    reasons.push(`Consumo de ${signals.consumedInWindow} nos últimos ${ctx.windowDays} dia(s) (${signals.dailyConsumptionRate}/dia).`);
  }
  if (ctx.projects.length > 0) {
    reasons.push(`${ctx.projects.length} obra(s) ativa(s) requisitando o item, com ${signals.pendingProjectDemand} ainda pendente(s) de baixa.`);
  }
  if (signals.minimumQuantity !== null) {
    reasons.push(`Estoque mínimo do item: ${signals.minimumQuantity} (fonte: ${ctx.thresholdSource}).`);
  }
  const leadLabel = {
    OBSERVED: `observado em ${ctx.leadTimeSampleSize} recebimento(s) reais`,
    TENANT_SETTING: 'padrão configurado da empresa',
    DEFAULT: 'padrão do sistema — sem histórico de reposição nem configuração',
  }[ctx.leadTimeSource];
  reasons.push(`Lead time de ${signals.leadTimeDays} dia(s) (${leadLabel}).`);
  reasons.push(`Saldo projetado ${signals.projectedOnHand} <= ponto de reposição ${signals.reorderPoint}.`);
  if (signals.stockoutRisk) {
    reasons.push(signals.daysOfCoverage !== null
      ? `Risco de falta: cobertura de ${signals.daysOfCoverage} dia(s), menor que o lead time.`
      : 'Risco de falta: saldo projetado zerado ou negativo.');
  }
  return reasons;
}

async function computePurchaseSuggestions(tenant, options, transaction) {
  const windowDays = resolveWindowDays(options.windowDays);
  const now = new Date();
  const since = new Date(now.getTime() - windowDays * 86400000);

  const balances = await loadCandidateBalances({ companyId: tenant.companyId, inventoryItemId: options.inventoryItemId, locationId: options.locationId }, transaction);
  // Sequencial de propósito: todas as queries compartilham a MESMA conexão da transação.
  const consumption = await loadConsumption({ companyId: tenant.companyId, since }, transaction);
  const projectDemand = await loadActiveProjectDemand({ companyId: tenant.companyId, since }, transaction);
  const defaultLeadTime = await resolveDefaultLeadTime(tenant, transaction);
  const itemIds = [...new Set(balances.map((b) => b.inventoryItemId))];
  const observedLeadTimes = await loadObservedLeadTimes({ companyId: tenant.companyId, itemIds }, transaction);

  const suggestions = [];
  for (const b of balances) {
    const key = keyOf(b.inventoryItemId, b.locationId);
    const consumptionEntry = consumption.get(key) || { consumed: 0, movementCount: 0 };
    const demandEntry = projectDemand.get(key) || { pendingQuantity: 0, projects: [] };
    const observed = observedLeadTimes.get(b.inventoryItemId);
    const leadTimeDays = observed ? observed.days : defaultLeadTime.days;
    const leadTimeSource = observed ? 'OBSERVED' : defaultLeadTime.source;

    // TODO(EST-012): trocar este limiar pelo threshold do motor de regras de estoque mínimo
    // (minStockRules.service.js, em construção em paralelo por outro agente) assim que ele
    // existir. Até lá, a fonte é o campo `minimum_quantity` do próprio item — o mesmo que
    // movements.service.js já usa para publicar inventory.stock.low por local.
    const thresholdSource = 'ITEM_MINIMUM_QUANTITY';

    const signals = computePurchaseSignals({
      quantityOnHand: b.quantityOnHand,
      minimumQuantity: b.minimumQuantity,
      consumed: consumptionEntry.consumed,
      windowDays,
      leadTimeDays,
      pendingQuantity: demandEntry.pendingQuantity,
    });
    if (!signals) continue;

    suggestions.push({
      key,
      inventoryItemId: b.inventoryItemId,
      locationId: b.locationId,
      riskLevel: signals.riskLevel,
      payload: {
        component: COMPONENT_NAME,
        method: 'RULE_BASED',
        inventoryItemId: b.inventoryItemId,
        itemName: b.itemName,
        sku: b.sku,
        unitOfMeasure: b.unitOfMeasure,
        averageCost: b.averageCost != null ? Number(b.averageCost) : null,
        locationId: b.locationId,
        locationName: b.locationName,
        windowDays,
        ...signals,
        leadTimeSource,
        leadTimeSampleSize: observed ? observed.sampleSize : 0,
        thresholdSource,
        consumptionMovementCount: consumptionEntry.movementCount,
        activeProjects: demandEntry.projects,
        estimatedCost: b.averageCost != null ? round4(Number(b.averageCost) * signals.suggestedQuantity) : null,
        reasons: buildReasons(signals, { windowDays, projects: demandEntry.projects, thresholdSource, leadTimeSource, leadTimeSampleSize: observed ? observed.sampleSize : 0 }),
        computedAt: now.toISOString(),
        // EST-013: registro explícito de que nada foi efetivado por esta sugestão.
        decisionsMade: [],
      },
    });
  }
  return { windowDays, suggestions };
}

// --- Persistência das sugestões (schema "ai") ---------------------------------------------

async function generatePurchaseSuggestions(payload, actorUserId, transaction) {
  const { groupId, companyId, windowDays, inventoryItemId, locationId } = payload;
  if (!groupId || !companyId) {
    throw AppError.badRequest('Os campos "groupId" e "companyId" são obrigatórios.', 'INVENTORY_NAY_VALIDATION');
  }
  const tenant = { groupId, companyId };

  // Serializa gerações concorrentes da mesma empresa (duas abas/dois usuários clicando ao mesmo
  // tempo) — sem isso, ambas leriam "nenhuma PENDING" e criariam sugestões duplicadas.
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:lockKey))', {
    replacements: { lockKey: `nay-estoque:purchase-suggestions:${companyId}` },
    transaction,
  });

  const computed = await computePurchaseSuggestions(tenant, { windowDays, inventoryItemId, locationId }, transaction);

  const aiRun = await AiRun.create(
    {
      groupId,
      companyId,
      userId: actorUserId || null,
      agentName: AGENT_NAME,
      inputSummary: `Sugestão de compra (consumo ${computed.windowDays}d, obras ativas, lead time, estoque)${inventoryItemId ? ` — item ${inventoryItemId}` : ''}${locationId ? ` — local ${locationId}` : ''}.`,
      toolCallsJson: {
        method: 'RULE_BASED',
        windowDays: computed.windowDays,
        reviewPeriodDays: REVIEW_PERIOD_DAYS,
        activeProjectStatuses: ACTIVE_PROJECT_STATUSES,
        filters: { inventoryItemId: inventoryItemId || null, locationId: locationId || null },
      },
      outputSummary: `${computed.suggestions.length} sugestão(ões) de compra calculada(s). Nenhuma compra efetivada (EST-013).`,
      status: 'COMPLETED',
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  const pendingWhere = { companyId, recommendationType: RECOMMENDATION_TYPE_PURCHASE, status: 'PENDING' };
  if (inventoryItemId) pendingWhere.relatedEntityId = inventoryItemId;
  // FOR UPDATE (sem include): uma aprovação/rejeição humana concorrente espera este recálculo
  // terminar (ou vice-versa) — sem isso o recálculo poderia sobrescrever a decisão ou marcar
  // como EXPIRED uma sugestão que acabou de ser aceita.
  const existingPending = await AiRecommendation.findAll({ where: pendingWhere, transaction, lock: transaction.LOCK.UPDATE });
  const existingByKey = new Map();
  for (const rec of existingPending) {
    const recLocationId = rec.payloadJson?.locationId;
    if (rec.status !== 'PENDING') continue; // decidida enquanto esperávamos o lock
    if (locationId && recLocationId !== locationId) continue;
    existingByKey.set(keyOf(rec.relatedEntityId, recLocationId), rec);
  }

  const recentlyRejected = await AiRecommendation.findAll({
    where: {
      companyId,
      recommendationType: RECOMMENDATION_TYPE_PURCHASE,
      status: 'REJECTED',
      updated_at: { [Op.gte]: new Date(Date.now() - REJECTION_COOLDOWN_DAYS * 86400000) },
    },
    transaction,
  });
  const rejectedRiskByKey = new Map();
  for (const rec of recentlyRejected) rejectedRiskByKey.set(keyOf(rec.relatedEntityId, rec.payloadJson?.locationId), rec.riskLevel);

  const results = [];
  let suppressedCount = 0;
  for (const s of computed.suggestions) {
    const existing = existingByKey.get(s.key);
    const rejectedRisk = rejectedRiskByKey.get(s.key);
    if (!existing && rejectedRisk && !(s.riskLevel === 'HIGH' && rejectedRisk !== 'HIGH')) {
      suppressedCount += 1;
      continue;
    }
    if (existing) {
      // Mesma necessidade ainda aberta: atualiza os sinais (sem duplicar a sugestão).
      existing.payloadJson = { ...s.payload, firstSuggestedAt: existing.payloadJson?.firstSuggestedAt || existing.created_at };
      existing.riskLevel = s.riskLevel;
      existing.aiRunId = aiRun.id;
      existing.updatedBy = actorUserId || null;
      await existing.save({ transaction });
      existingByKey.delete(s.key);
      results.push(existing);
    } else {
      const created = await AiRecommendation.create(
        {
          groupId,
          companyId,
          aiRunId: aiRun.id,
          relatedEntityType: RELATED_ENTITY_ITEM,
          relatedEntityId: s.inventoryItemId,
          recommendationType: RECOMMENDATION_TYPE_PURCHASE,
          payloadJson: { ...s.payload, firstSuggestedAt: new Date().toISOString() },
          riskLevel: s.riskLevel,
          status: 'PENDING',
          createdBy: actorUserId || null,
          updatedBy: actorUserId || null,
        },
        { transaction }
      );
      results.push(created);
    }
  }

  // Sugestão PENDING cuja necessidade sumiu (estoque reposto, consumo caiu) não fica pendurada
  // como se ainda valesse: vira EXPIRED, com o motivo — nunca é "aceita" automaticamente.
  let expiredCount = 0;
  for (const stale of existingByKey.values()) {
    stale.status = 'EXPIRED';
    stale.payloadJson = {
      ...(stale.payloadJson || {}),
      expiredAt: new Date().toISOString(),
      expiredReason: 'Recalculada pela NAY Estoque: os sinais atuais não indicam mais necessidade de compra.',
      expiredByAiRunId: aiRun.id,
    };
    stale.updatedBy = actorUserId || null;
    await stale.save({ transaction });
    expiredCount += 1;
  }

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'INVENTORY_NAY_SUGGESTIONS_GENERATED',
      entityType: 'AiRun',
      entityId: aiRun.id,
      reason: `NAY Estoque: ${results.length} sugestão(ões) de compra ativa(s), ${expiredCount} expirada(s). Nenhuma compra efetivada.`,
    },
    transaction
  );

  return {
    component: COMPONENT_NAME,
    aiRunId: aiRun.id,
    windowDays: computed.windowDays,
    suggestions: results.map(serializeSuggestion),
    expiredCount,
    suppressedByRecentRejection: suppressedCount,
    decisionsMade: [],
  };
}

function serializeSuggestion(rec) {
  const json = typeof rec.toJSON === 'function' ? rec.toJSON() : rec;
  return {
    id: json.id,
    status: json.status,
    riskLevel: json.riskLevel,
    aiRunId: json.aiRunId,
    inventoryItemId: json.relatedEntityId,
    decidedByUserId: json.decidedByUserId,
    createdAt: json.created_at || json.createdAt,
    updatedAt: json.updated_at || json.updatedAt,
    ...(json.payloadJson || {}),
  };
}

async function listPurchaseSuggestions(transaction, { status, inventoryItemId } = {}) {
  const where = { recommendationType: RECOMMENDATION_TYPE_PURCHASE };
  if (status && status !== 'ALL') where.status = status;
  else if (!status) where.status = 'PENDING';
  if (inventoryItemId) where.relatedEntityId = inventoryItemId;
  const rows = await AiRecommendation.findAll({ where, order: [['updated_at', 'DESC']], transaction });
  // Pendentes primeiro, por risco (HIGH -> LOW); dentro do mesmo grupo mantém a ordem por
  // atualização mais recente (sort estável).
  const riskOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const rank = (s) => (s.status === 'PENDING' ? 0 : 10) + (riskOrder[s.riskLevel] ?? 3);
  return rows.map(serializeSuggestion).sort((a, b) => rank(a) - rank(b));
}

async function lockPendingSuggestion(suggestionId, transaction) {
  const rec = await AiRecommendation.findByPk(suggestionId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!rec || rec.recommendationType !== RECOMMENDATION_TYPE_PURCHASE) {
    throw AppError.notFound('Sugestão de compra não encontrada.', 'INVENTORY_NAY_SUGGESTION_NOT_FOUND');
  }
  if (rec.status !== 'PENDING') {
    throw AppError.badRequest(`Só é possível decidir uma sugestão PENDING (atual: ${rec.status}).`, 'INVENTORY_NAY_SUGGESTION_INVALID_TRANSITION');
  }
  return rec;
}

/**
 * approvePurchaseSuggestion — ÚNICO ponto onde uma sugestão da NAY vira efeito no sistema, e
 * só por ação humana explícita. O efeito é abrir uma requisição de compra (REQUESTED) pelo
 * service de Compras já existente — que segue o próprio workflow de aprovação antes de virar
 * cotação/pedido. O humano pode ajustar a quantidade sugerida.
 */
async function approvePurchaseSuggestion(suggestionId, payload, actor, transaction) {
  const { quantity, notes, projectId } = payload || {};
  const rec = await lockPendingSuggestion(suggestionId, transaction);
  const data = rec.payloadJson || {};

  const finalQuantity = quantity != null && quantity !== '' ? Number(quantity) : Number(data.suggestedQuantity);
  if (!Number.isFinite(finalQuantity) || finalQuantity <= 0) {
    throw AppError.badRequest('"quantity" precisa ser um número maior que zero.', 'INVENTORY_NAY_VALIDATION');
  }

  const item = await InventoryItem.findByPk(rec.relatedEntityId, { transaction });
  if (!item) throw AppError.notFound('Item de estoque da sugestão não encontrado.', 'INVENTORY_ITEM_NOT_FOUND');
  if (projectId) {
    // Lido sob RLS: obra de outra empresa simplesmente não é encontrada (FK sozinha não isola tenant).
    const project = await Project.findByPk(projectId, { transaction });
    if (!project) throw AppError.notFound('Obra informada não encontrada.', 'PROJECT_NOT_FOUND');
  }
  if (item.status !== 'ACTIVE') {
    throw AppError.badRequest('O item da sugestão está inativo — não é possível abrir compra para ele.', 'INVENTORY_NAY_ITEM_INACTIVE');
  }

  const noteParts = [`Origem: sugestão NAY Estoque ${rec.id} aprovada por usuário (EST-013).`];
  if (data.locationName) noteParts.push(`Reposição do local "${data.locationName}".`);
  if (notes) noteParts.push(String(notes));

  const purchaseRequest = await procurementService.createPurchaseRequest(
    {
      groupId: rec.groupId,
      companyId: rec.companyId,
      projectId: projectId || null,
      notes: noteParts.join(' '),
      items: [{ inventoryItemId: item.id, description: item.sku ? `${item.name} (${item.sku})` : item.name, quantity: finalQuantity }],
    },
    actor.userId,
    transaction
  );

  rec.status = 'ACCEPTED';
  rec.decidedByUserId = actor.userId || null;
  rec.updatedBy = actor.userId || null;
  rec.payloadJson = {
    ...data,
    decision: {
      decision: 'ACCEPTED',
      decidedByUserId: actor.userId || null,
      decidedAt: new Date().toISOString(),
      suggestedQuantity: data.suggestedQuantity,
      approvedQuantity: finalQuantity,
      purchaseRequestId: purchaseRequest.id,
    },
  };
  await rec.save({ transaction });

  await registrarAuditoria(
    {
      groupId: rec.groupId,
      companyId: rec.companyId,
      actorUserId: actor.userId,
      action: 'INVENTORY_NAY_SUGGESTION_ACCEPTED',
      entityType: 'AiRecommendation',
      entityId: rec.id,
      reason: `Sugestão de compra aprovada por humano — requisição de compra ${purchaseRequest.id} aberta (${finalQuantity}).`,
    },
    transaction
  );

  return { suggestion: serializeSuggestion(rec), purchaseRequest };
}

async function rejectPurchaseSuggestion(suggestionId, payload, actor, transaction) {
  const { reason } = payload || {};
  const rec = await lockPendingSuggestion(suggestionId, transaction);
  rec.status = 'REJECTED';
  rec.decidedByUserId = actor.userId || null;
  rec.updatedBy = actor.userId || null;
  rec.payloadJson = {
    ...(rec.payloadJson || {}),
    decision: { decision: 'REJECTED', decidedByUserId: actor.userId || null, decidedAt: new Date().toISOString(), reason: reason || null },
  };
  await rec.save({ transaction });

  await registrarAuditoria(
    {
      groupId: rec.groupId,
      companyId: rec.companyId,
      actorUserId: actor.userId,
      action: 'INVENTORY_NAY_SUGGESTION_REJECTED',
      entityType: 'AiRecommendation',
      entityId: rec.id,
      reason: `Sugestão de compra rejeitada por humano${reason ? `: ${reason}` : '.'}`,
    },
    transaction
  );
  return serializeSuggestion(rec);
}

// --- Anomalias em loss_cases (somente leitura) --------------------------------------------

/**
 * analyzeLossCaseAnomalies — EST-013 ("NAY pode sugerir ... anomalia") + EST-TS-14 ("IA sugere
 * culpa -> sem efeito financeiro"). Leitura PURA de "inventory"."loss_cases": não grava nada,
 * não altera status, não chama decideLossCase, não gera movimento nem lançamento financeiro.
 * O resultado é contexto adicional para o humano que vai decidir o caso pelo fluxo normal
 * (lossCases.service.js#decideLossCase, que exige inventory:approve) — nunca uma decisão.
 *
 * Regras (heurísticas simples e auditáveis, cada flag lista os casos que a sustentam):
 *   RECURRENCE_ITEM_LOCATION — >= RECURRENCE_MIN_CASES casos do mesmo item/ativo no mesmo local
 *                              na janela.
 *   RECURRENCE_RESPONSIBLE   — >= RECURRENCE_MIN_CASES casos com o mesmo responsável na janela.
 *   VALUE_ABOVE_HISTORY      — valor do caso > VALUE_ANOMALY_FACTOR x média histórica
 *                              (VALUE_HISTORY_DAYS) dos demais casos do mesmo item/ativo, com
 *                              pelo menos VALUE_HISTORY_MIN_SAMPLES casos de base.
 * Casos REJECTED não contam como evidência (um humano já decidiu que não houve perda).
 */
async function analyzeLossCaseAnomalies(tenant, options, transaction) {
  const windowDays = resolveWindowDays(options.windowDays);
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowDays * 86400000);
  const historyStart = new Date(now.getTime() - Math.max(windowDays, VALUE_HISTORY_DAYS) * 86400000);

  const rows = await sequelize.query(
    `SELECT lc.id, lc.inventory_item_id AS "inventoryItemId", lc.asset_id AS "assetId",
            lc.location_id AS "locationId", lc.project_id AS "projectId",
            lc.responsible_person_id AS "responsiblePersonId", lc.quantity, lc.estimated_cost AS "estimatedCost",
            lc.status, lc.created_at AS "createdAt", i.average_cost AS "averageCost"
       FROM inventory.loss_cases lc
       LEFT JOIN inventory.inventory_items i ON i.id = lc.inventory_item_id
      WHERE lc.company_id = :companyId AND lc.created_at >= :historyStart
      ORDER BY lc.created_at DESC`,
    { replacements: { companyId: tenant.companyId, historyStart }, type: sequelize.QueryTypes.SELECT, transaction }
  );

  const cases = rows.map((r) => {
    let value = null;
    if (r.estimatedCost != null) value = Number(r.estimatedCost);
    else if (r.quantity != null && r.averageCost != null) value = Number(r.quantity) * Number(r.averageCost);
    return {
      ...r,
      subjectKey: r.inventoryItemId ? `item:${r.inventoryItemId}` : r.assetId ? `asset:${r.assetId}` : null,
      value,
      inWindow: new Date(r.createdAt) >= windowStart,
      countsAsEvidence: r.status !== 'REJECTED',
    };
  });

  const evidenceInWindow = cases.filter((c) => c.inWindow && c.countsAsEvidence);
  const bySubjectLocation = new Map();
  const byResponsible = new Map();
  for (const c of evidenceInWindow) {
    if (c.locationId && c.subjectKey) {
      const k = `${c.subjectKey}|${c.locationId}`;
      bySubjectLocation.set(k, [...(bySubjectLocation.get(k) || []), c.id]);
    }
    if (c.responsiblePersonId) {
      byResponsible.set(c.responsiblePersonId, [...(byResponsible.get(c.responsiblePersonId) || []), c.id]);
    }
  }

  const targets = cases.filter((c) => (options.lossCaseId ? c.id === options.lossCaseId : c.inWindow));
  if (options.lossCaseId && targets.length === 0) {
    throw AppError.notFound('Caso de perda não encontrado na janela analisada.', 'LOSS_CASE_NOT_FOUND');
  }

  const results = [];
  for (const c of targets) {
    const flags = [];
    if (c.locationId && c.subjectKey) {
      const related = bySubjectLocation.get(`${c.subjectKey}|${c.locationId}`) || [];
      if (related.length >= RECURRENCE_MIN_CASES) {
        flags.push({
          code: 'RECURRENCE_ITEM_LOCATION',
          severity: 'MEDIUM',
          message: `${related.length} casos de perda do mesmo ${c.inventoryItemId ? 'item' : 'ativo'} neste local nos últimos ${windowDays} dia(s).`,
          relatedLossCaseIds: related,
        });
      }
    }
    if (c.responsiblePersonId) {
      const related = byResponsible.get(c.responsiblePersonId) || [];
      if (related.length >= RECURRENCE_MIN_CASES) {
        flags.push({
          code: 'RECURRENCE_RESPONSIBLE',
          severity: 'MEDIUM',
          message: `${related.length} casos de perda com o mesmo responsável nos últimos ${windowDays} dia(s). Indício para apuração — não é atribuição de culpa.`,
          relatedLossCaseIds: related,
        });
      }
    }
    if (c.value != null && c.subjectKey) {
      const baseline = cases.filter((o) => o.id !== c.id && o.subjectKey === c.subjectKey && o.countsAsEvidence && o.value != null);
      if (baseline.length >= VALUE_HISTORY_MIN_SAMPLES) {
        const mean = baseline.reduce((s, o) => s + o.value, 0) / baseline.length;
        if (mean > 0 && c.value > VALUE_ANOMALY_FACTOR * mean) {
          flags.push({
            code: 'VALUE_ABOVE_HISTORY',
            severity: 'HIGH',
            message: `Valor do caso (${round4(c.value)}) acima de ${VALUE_ANOMALY_FACTOR}x a média histórica do mesmo ${c.inventoryItemId ? 'item' : 'ativo'} (${round4(mean)}, ${baseline.length} caso(s)).`,
            relatedLossCaseIds: baseline.map((o) => o.id),
          });
        }
      }
    }
    if (flags.length > 0 || options.lossCaseId) {
      results.push({ lossCaseId: c.id, status: c.status, responsiblePersonId: c.responsiblePersonId, value: c.value != null ? round4(c.value) : null, flags });
    }
  }

  return {
    component: COMPONENT_NAME,
    method: 'RULE_BASED',
    generatedAt: now.toISOString(),
    parameters: { windowDays, recurrenceMinCases: RECURRENCE_MIN_CASES, valueAnomalyFactor: VALUE_ANOMALY_FACTOR, valueHistoryDays: VALUE_HISTORY_DAYS },
    // EST-TS-14: sinalização apenas. Nenhum caso decidido, nenhum movimento, nenhum efeito
    // financeiro. Responsabilidade/cobrança só existe por decisão humana no fluxo do caso.
    financialEffect: 'NONE',
    decisionsMade: [],
    disclaimer: 'Sugestão da NAY: indícios para apoiar a decisão humana. Não atribui culpa, não decide o caso e não gera cobrança.',
    cases: results,
  };
}

module.exports = {
  AGENT_NAME,
  RECOMMENDATION_TYPE_PURCHASE,
  FALLBACK_LEAD_TIME_DAYS,
  REVIEW_PERIOD_DAYS,
  REJECTION_COOLDOWN_DAYS,
  ACTIVE_PROJECT_STATUSES,
  computePurchaseSignals,
  computePurchaseSuggestions,
  generatePurchaseSuggestions,
  listPurchaseSuggestions,
  approvePurchaseSuggestion,
  rejectPurchaseSuggestion,
  analyzeLossCaseAnomalies,
};
