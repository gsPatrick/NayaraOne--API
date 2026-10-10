'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const inventoryController = require('./inventory.controller');

const inventoryRouter = Router();

inventoryRouter.use(authMiddleware, tenantMiddleware);

inventoryRouter.post('/inventory/items', requirePermission('inventory:create'), inventoryController.createItem);
inventoryRouter.get('/inventory/items', requirePermission('inventory:read'), inventoryController.listItems);
inventoryRouter.get('/inventory/items/:id', requirePermission('inventory:read'), inventoryController.getItem);
inventoryRouter.get('/inventory/items/:id/balances', requirePermission('inventory:read'), inventoryController.listBalancesByItem);
// EST-012 — estoque mínimo/reposição vêm do Motor de Regras (REG-EST-001): política por item,
// com sobreposição opcional por local (minStockRules.service.js).
inventoryRouter.get('/inventory/items/:id/min-stock-rule', requirePermission('inventory:read'), inventoryController.getItemMinStockRule);
inventoryRouter.post('/inventory/items/:id/min-stock-rule', requirePermission('inventory:update'), inventoryController.createItemMinStockRule);
inventoryRouter.get('/inventory/adjustment-risk-rule', requirePermission('inventory:read'), inventoryController.getAdjustmentRiskRule);
inventoryRouter.post('/inventory/adjustment-risk-rule', requirePermission('inventory:approve'), inventoryController.createAdjustmentRiskRule);
inventoryRouter.post('/inventory/items/:id/status', requirePermission('inventory:update'), inventoryController.setItemStatus);

inventoryRouter.post('/inventory/locations', requirePermission('inventory:create'), inventoryController.createLocation);
inventoryRouter.get('/inventory/locations', requirePermission('inventory:read'), inventoryController.listLocations);

// Movimento de estoque — único ponto de escrita de "inventory"."stock_balances" (EST-002).
// ADJUSTMENT/LOSS/DISPOSAL exigem inventory:approve, validado dentro do service (movements.service.js).
inventoryRouter.post('/inventory/movements', requirePermission('inventory:create'), inventoryController.recordMovement);

// Receipts/NF (Guia do Marcelo §4) — DRAFT -> REVIEWED -> COMPLETED.
inventoryRouter.post('/inventory/receipts', requirePermission('inventory:create'), inventoryController.createReceipt);
inventoryRouter.get('/inventory/receipts', requirePermission('inventory:read'), inventoryController.listReceipts);
inventoryRouter.get('/inventory/receipts/:id', requirePermission('inventory:read'), inventoryController.getReceipt);
inventoryRouter.post('/inventory/receipts/:id/review', requirePermission('inventory:update'), inventoryController.reviewReceipt);
inventoryRouter.post('/inventory/receipts/:id/confirm', requirePermission('inventory:create'), inventoryController.confirmReceipt);

// Requisitions (Guia do Marcelo §5) — REQUESTED -> APPROVED/REJECTED -> ISSUED (OUT com project_id/stage_id, EST-004).
inventoryRouter.post('/inventory/requisitions', requirePermission('inventory:create'), inventoryController.createRequisition);
inventoryRouter.get('/inventory/requisitions', requirePermission('inventory:read'), inventoryController.listRequisitions);
inventoryRouter.get('/inventory/requisitions/:id', requirePermission('inventory:read'), inventoryController.getRequisition);
inventoryRouter.post('/inventory/requisitions/:id/decide', requirePermission('inventory:approve'), inventoryController.decideRequisition);
inventoryRouter.post('/inventory/requisitions/:id/issue', requirePermission('inventory:create'), inventoryController.issueRequisition);

// Assets/QR (Guia do Marcelo §6/§9) — asset_tag UNIQUE (EST-TS-04), QR só identificador opaco.
inventoryRouter.post('/assets', requirePermission('inventory:create'), inventoryController.createAsset);
inventoryRouter.get('/assets', requirePermission('inventory:read'), inventoryController.listAssets);
inventoryRouter.patch('/assets/:id', requirePermission('inventory:update'), inventoryController.updateAsset);
inventoryRouter.get('/assets/by-tag/:tag', requirePermission('inventory:read'), inventoryController.getAssetByTag);
inventoryRouter.post('/assets/:id/transfer', requirePermission('inventory:update'), inventoryController.transferAsset);
inventoryRouter.get('/assets/:id/movements', requirePermission('inventory:read'), inventoryController.listAssetMovements);
// Venda/descarte/doação (Caderno §9) — exige inventory:approve (validado também no service);
// valor > 0 gera lançamento RECEIVABLE no Financeiro na mesma transação.
inventoryRouter.post('/assets/:id/dispose', requirePermission('inventory:approve'), inventoryController.disposeAsset);
inventoryRouter.get('/assets/:id/disposal', requirePermission('inventory:read'), inventoryController.getAssetDisposal);

// Tool loans (Guia do Marcelo §6/§7) — OPEN -> RETURNED. EST-TS-05 bloqueia novo empréstimo de ferramenta já emprestada.
inventoryRouter.post('/assets/:id/loan', requirePermission('inventory:create'), inventoryController.loanTool);
inventoryRouter.post('/tool-loans/:id/return', requirePermission('inventory:update'), inventoryController.returnTool);
inventoryRouter.get('/tool-loans', requirePermission('inventory:read'), inventoryController.listToolLoans);

// Maintenance orders (Guia do Marcelo §8) — OPEN -> CLOSED.
inventoryRouter.post('/maintenance-orders', requirePermission('inventory:create'), inventoryController.openMaintenanceOrder);
inventoryRouter.get('/maintenance-orders', requirePermission('inventory:read'), inventoryController.listMaintenanceOrders);
inventoryRouter.post('/maintenance-orders/:id/close', requirePermission('inventory:update'), inventoryController.closeMaintenanceOrder);

// Loss cases (Guia do Marcelo §11, EST-010) — OPEN -> APPROVED/REJECTED. Decisão exige inventory:approve.
inventoryRouter.post('/inventory/loss-cases', requirePermission('inventory:create'), inventoryController.openLossCase);
inventoryRouter.get('/inventory/loss-cases', requirePermission('inventory:read'), inventoryController.listLossCases);
inventoryRouter.post('/inventory/loss-cases/:id/decide', requirePermission('inventory:approve'), inventoryController.decideLossCase);

// Counts/inventário físico (Guia do Marcelo §8/item 10) — OPEN -> COMPLETED. Fechamento nunca
// altera saldo (EST-TS-09); ajuste é um ato separado e aprovado por linha divergente.
inventoryRouter.post('/inventory/counts', requirePermission('inventory:create'), inventoryController.openCount);
inventoryRouter.get('/inventory/counts', requirePermission('inventory:read'), inventoryController.listCounts);
inventoryRouter.get('/inventory/counts/:id', requirePermission('inventory:read'), inventoryController.getCount);
inventoryRouter.post('/inventory/counts/:id/items', requirePermission('inventory:create'), inventoryController.addCountItem);
inventoryRouter.post('/inventory/counts/:id/complete', requirePermission('inventory:create'), inventoryController.completeCount);
inventoryRouter.post('/inventory/count-items/:countItemId/apply-adjustment', requirePermission('inventory:approve'), inventoryController.applyCountAdjustment);

module.exports = inventoryRouter;
