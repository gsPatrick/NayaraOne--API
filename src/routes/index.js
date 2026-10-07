'use strict';

const { Router } = require('express');
const { healthRouter, pingRouter } = require('../features/health/health.routes');
const authRouter = require('../features/auth/auth.routes');
const groupsRouter = require('../features/groups/groups.routes');
const companiesRouter = require('../features/companies/companies.routes');
const unitsRouter = require('../features/units/units.routes');
const usersRouter = require('../features/users/users.routes');
const membershipsRouter = require('../features/memberships/memberships.routes');
const rolesRouter = require('../features/roles/roles.routes');
const peopleRouter = require('../features/people/people.routes');
const propertiesRouter = require('../features/properties/properties.routes');
const crmRouter = require('../features/crm/crm.routes');
const crmController = require('../features/crm/crm.controller');
const radarRouter = require('../features/radar/radar.routes');
const financeRouter = require('../features/finance/finance.routes');
const legalRouter = require('../features/legal/legal.routes');
const legalController = require('../features/legal/legal.controller');
const financeController = require('../features/finance/finance.controller');
const constructionRouter = require('../features/construction/construction.routes');
const inventoryRouter = require('../features/inventory/inventory.routes');
const procurementRouter = require('../features/procurement/procurement.routes');
const insuranceController = require('../features/procurement/insurance.controller');
const auditRouter = require('../features/audit/audit.routes');
const billingRouter = require('../features/billing/billing.routes');
const settingsRouter = require('../features/settings/settings.routes');
const filesRouter = require('../features/files/files.routes');

/**
 * Agregador único de rotas da API.
 * Toda nova feature deve ser montada aqui — nenhuma outra parte do código
 * deve registrar rotas diretamente no app Express.
 */
const router = Router();

// GET /health — fora do prefixo /v1, usado por health checks de infraestrutura.
router.use('/', healthRouter);

// Webhook público do Clicksign — PRECISA vir antes de qualquer router com gate de autenticação
// genérico. Bug real encontrado em produção (19/09/2026): vários routers montados em "/v1"
// (groups, companies, units, users, memberships, roles, people, properties, crm, radar,
// finance) têm `algumRouter.use(authMiddleware)` SEM path, que intercepta QUALQUER requisição
// que chegue até aquele router — não só as rotas dele. Como o Express tenta cada router
// montado em "/v1" em ordem, o primeiro desses (groupsRouter) rejeitava com 401 toda chamada
// do Clicksign ao nosso webhook antes do legalRouter sequer ser tentado. Registrar a rota
// pública aqui, no topo do agregador, garante que ela responde e termina a requisição antes
// de qualquer um desses gates. A verificação de autenticidade não é o JWT do app — é o HMAC
// do corpo bruto (ver clicksignPublicWebhook/verifyProviderWebhookSignature em
// legal.controller.js), validado contra o segredo por-tenant resolvido via a tabela de
// roteamento sem RLS (migration 20260101000172).
router.post('/v1/legal/webhooks/clicksign', legalController.clicksignPublicWebhook);
// Mesmo motivo acima, pro webhook do provider bancário (PROVIDER_BANCARIO.md) — resolve o
// tenant via BankPaymentProviderRouting (sem RLS), nunca via JWT (o banco não tem um).
router.post('/v1/finance/webhooks/bank-payment', financeController.bankPaymentPublicWebhook);
// Mesmo motivo acima, pro webhook de seguradora (Insurance Hub, Marco 7) — resolve o tenant via
// InsuranceProviderSubmission (sem RLS).
router.post('/v1/procurement/webhooks/insurance', insuranceController.insurancePublicWebhook);
// Carrinho de imóveis compartilhável (crm.carts, item 3) — link PÚBLICO, sem JWT (quem recebe
// o link é um lead/cliente final, não um usuário do sistema). Resolve o tenant via
// CartShareRouting (sem RLS), mesmo padrão dos webhooks acima.
router.get('/v1/crm/carts/public/:token', crmController.getPublicCart);
router.post('/v1/crm/carts/public/:token/properties/:propertyId/click', crmController.clickPublicCartProperty);

// Rotas de domínio versionadas.
router.use('/v1', pingRouter);
router.use('/v1', authRouter);
router.use('/v1', groupsRouter);
router.use('/v1', companiesRouter);
router.use('/v1', unitsRouter);
router.use('/v1', usersRouter);
router.use('/v1', membershipsRouter);
router.use('/v1', rolesRouter);
router.use('/v1', peopleRouter);
router.use('/v1', propertiesRouter);
router.use('/v1', crmRouter);
router.use('/v1', radarRouter);
router.use('/v1', financeRouter);
router.use('/v1', legalRouter);
router.use('/v1', constructionRouter);
router.use('/v1', inventoryRouter);
router.use('/v1', procurementRouter);
router.use('/v1', auditRouter);
router.use('/v1', billingRouter);
router.use('/v1', settingsRouter);
router.use('/v1', filesRouter);

module.exports = router;
