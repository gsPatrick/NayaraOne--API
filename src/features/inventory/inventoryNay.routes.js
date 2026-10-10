'use strict';

const { Router } = require('express');
const { authMiddleware, requirePermission } = require('../../middlewares/auth.middleware');
const tenantMiddleware = require('../../middlewares/tenant.middleware');
const controller = require('./inventoryNay.controller');

// NAY Estoque (EST-013 / Guia §12 / EST-TS-14) + OCR/IA de NF (Guia §6). Router separado de
// inventory.routes.js para não misturar o núcleo transacional do estoque com a camada
// assistiva da NAY. Nenhuma rota aqui movimenta saldo nem decide caso de perda.
const inventoryNayRouter = Router();

inventoryNayRouter.use(authMiddleware, tenantMiddleware);

// Gerar/recalcular sugestões grava registros no schema "ai" (nunca em compras/estoque).
inventoryNayRouter.post('/inventory/nay/purchase-suggestions/generate', requirePermission('inventory:create'), controller.generatePurchaseSuggestions);
inventoryNayRouter.get('/inventory/nay/purchase-suggestions', requirePermission('inventory:read'), controller.listPurchaseSuggestions);
// Aprovar = ação humana que abre a requisição de compra; exige a MESMA permissão de quem abre
// uma requisição de compra manualmente (procurement.routes.js).
inventoryNayRouter.post('/inventory/nay/purchase-suggestions/:id/approve', requirePermission('procurement:create'), controller.approvePurchaseSuggestion);
inventoryNayRouter.post('/inventory/nay/purchase-suggestions/:id/reject', requirePermission('procurement:create'), controller.rejectPurchaseSuggestion);
// Anomalias em casos de perda — leitura pura, sem efeito (EST-TS-14).
inventoryNayRouter.get('/inventory/nay/loss-case-anomalies', requirePermission('inventory:read'), controller.listLossCaseAnomalies);

// OCR/IA de NF: anexa o arquivo e devolve sugestão; NÃO cria recebimento (usuário confere antes).
inventoryNayRouter.post('/inventory/receipts/ocr-suggestions', requirePermission('inventory:create'), controller.suggestReceiptFromInvoice);

module.exports = inventoryNayRouter;
