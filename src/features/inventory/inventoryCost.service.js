'use strict';

const { Op } = require('sequelize');
const { InventoryMovement, InventoryLocation } = require('../../models');

/**
 * Custo de estoque levado à obra — revisão Marco 7 (19/10/2026), item A1 / EST-011.
 *
 * Antes: a obra somava OUT − RETURN × custo médio ATUAL do item (o histórico mudava a cada nova
 * compra) e ignorava a volta do canteiro ao almoxarifado e os ajustes no canteiro.
 *
 * Agora cada movimento grava `unit_cost`/`total_cost` no momento do fato (movements.service.js
 * #recordMovement) e a obra soma esses valores HISTÓRICOS. Política (o Caderno diz só "custo
 * médio/FIFO/política definida e nunca duplicado"; escolhemos a política de CUSTÓDIA, a mais
 * conservadora contra cobrança dupla):
 *
 *   A obra é cobrada quando o material ENTRA na custódia dela e creditada quando SAI de volta
 *   para o estoque da empresa. O que acontece DENTRO da custódia (consumo, perda, descarte,
 *   ajuste para menos no canteiro) não muda o total — o material já foi cobrado na entrada, e
 *   cobrar de novo seria duplicar (EST-011).
 *
 *   +  OUT vinculado à obra saindo de um local que não é canteiro dela (entrega de requisição,
 *      saída manual para a obra);
 *   +  TRANSFER de fora para um canteiro da obra;
 *   +  IN num canteiro da obra que não seja a perna de entrada da própria requisição (essa perna
 *      é o par do OUT acima — contá-la duplicaria): recebimento direto no canteiro;
 *   +  ADJUSTMENT positivo num canteiro da obra (sobra aprovada entra na custódia);
 *   +  LOSS/DISPOSAL atribuído à obra fora do canteiro dela (perda imputada à obra);
 *   −  TRANSFER de um canteiro da obra para fora (sobra devolvida ao almoxarifado);
 *   −  RETURN vinculado à obra (devolução ao estoque);
 *   0  OUT/LOSS/DISPOSAL/ADJUSTMENT negativo dentro do canteiro (consumo/perda já cobrados).
 *
 * Créditos (−) usam o custo pelo qual o material foi levado à obra (média histórica das
 * entradas da obra para aquele item — ver getProjectChargedUnitCost), nunca o custo de hoje: se o
 * custo médio subiu, devolver não pode "render" mais do que foi cobrado.
 *
 * Movimentos anteriores à migration 20260101000580 têm custo preenchido com o melhor dado
 * disponível (custo da nota no recebimento ou custo médio do item na data da migration) e
 * `cost_source` BACKFILL_* — documentado na migration. Item sem custo conhecido entra como 0.
 */

function toNumber(value) {
  if (value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** +1 (entra na custódia da obra), −1 (sai da custódia) ou 0 (interno/fora da obra). */
function projectCostSign(movement, siteIds) {
  const src = movement.sourceLocationId;
  const dst = movement.destinationLocationId;
  const srcIsSite = Boolean(src && siteIds.has(src));
  const dstIsSite = Boolean(dst && siteIds.has(dst));
  switch (movement.movementType) {
    case 'OUT':
      return srcIsSite ? 0 : 1;
    case 'IN':
      return dstIsSite && movement.sourceType !== 'REQUISITION' ? 1 : 0;
    case 'TRANSFER':
      if (!srcIsSite && dstIsSite) return 1;
      if (srcIsSite && !dstIsSite) return -1;
      return 0;
    case 'RETURN':
      return dstIsSite ? 0 : -1;
    case 'ADJUSTMENT':
      return dstIsSite ? 1 : 0;
    case 'LOSS':
    case 'DISPOSAL':
      return srcIsSite ? 0 : 1;
    default:
      return 0;
  }
}

function movementValue(movement) {
  if (movement.totalCost != null) return toNumber(movement.totalCost);
  return toNumber(movement.quantity) * toNumber(movement.unitCost);
}

async function loadSitesByProject(projectIds, transaction) {
  const sites = await InventoryLocation.findAll({
    where: { projectId: { [Op.in]: projectIds }, locationType: 'PROJECT_SITE' },
    attributes: ['id', 'projectId'],
    transaction,
  });
  const byProject = new Map(projectIds.map((id) => [id, new Set()]));
  for (const s of sites) byProject.get(s.projectId)?.add(s.id);
  return byProject;
}

/** Map projectId → custo de estoque levado à obra (custo histórico, política de custódia). */
async function getConsumedInventoryCostByProject(projectIds, transaction) {
  const ids = [...new Set((projectIds || []).filter(Boolean))];
  const result = new Map(ids.map((id) => [id, 0]));
  if (ids.length === 0) return result;
  const [movements, sitesByProject] = await Promise.all([
    InventoryMovement.findAll({
      where: { projectId: { [Op.in]: ids } },
      attributes: ['projectId', 'movementType', 'sourceType', 'sourceLocationId', 'destinationLocationId', 'quantity', 'unitCost', 'totalCost'],
      transaction,
    }),
    loadSitesByProject(ids, transaction),
  ]);
  for (const m of movements) {
    const sign = projectCostSign(m, sitesByProject.get(m.projectId) || new Set());
    if (sign !== 0) result.set(m.projectId, result.get(m.projectId) + sign * movementValue(m));
  }
  for (const [k, v] of result) result.set(k, round2(v));
  return result;
}

async function getConsumedInventoryCost(projectId, transaction) {
  const map = await getConsumedInventoryCostByProject([projectId], transaction);
  return map.get(projectId) || 0;
}

/**
 * Custo unitário pelo qual o item foi levado a esta obra (média ponderada das entradas na
 * custódia). null quando nunca houve entrada com custo — o chamador cai no custo médio atual.
 */
async function getProjectChargedUnitCost(projectId, inventoryItemId, transaction) {
  const [movements, sitesByProject] = await Promise.all([
    InventoryMovement.findAll({
      where: { projectId, inventoryItemId },
      attributes: ['projectId', 'movementType', 'sourceType', 'sourceLocationId', 'destinationLocationId', 'quantity', 'unitCost', 'totalCost'],
      transaction,
    }),
    loadSitesByProject([projectId], transaction),
  ]);
  const siteIds = sitesByProject.get(projectId) || new Set();
  let qty = 0;
  let value = 0;
  for (const m of movements) {
    if (projectCostSign(m, siteIds) === 1 && m.unitCost != null) {
      qty += toNumber(m.quantity);
      value += movementValue(m);
    }
  }
  return qty > 0 ? value / qty : null;
}

module.exports = { projectCostSign, getConsumedInventoryCost, getConsumedInventoryCostByProject, getProjectChargedUnitCost };
