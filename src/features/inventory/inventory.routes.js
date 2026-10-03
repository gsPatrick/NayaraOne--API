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
inventoryRouter.get('/assets/by-tag/:tag', requirePermission('inventory:read'), inventoryController.getAssetByTag);
inventoryRouter.post('/assets/:id/transfer', requirePermission('inventory:update'), inventoryController.transferAsset);

module.exports = inventoryRouter;
