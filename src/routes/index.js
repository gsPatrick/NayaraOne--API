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
const portalListingsRouter = require('../features/integrations/portal/portal.routes');
const crmRouter = require('../features/crm/crm.routes');
const crmController = require('../features/crm/crm.controller');
const radarRouter = require('../features/radar/radar.routes');
const financeRouter = require('../features/finance/finance.routes');
const financeExportRouter = require('../features/finance/financeExport.routes');
const legalRouter = require('../features/legal/legal.routes');
const legalController = require('../features/legal/legal.controller');
const financeController = require('../features/finance/finance.controller');
const constructionRouter = require('../features/construction/construction.routes');
const inventoryRouter = require('../features/inventory/inventory.routes');
const inventoryNayRouter = require('../features/inventory/inventoryNay.routes');
const procurementRouter = require('../features/procurement/procurement.routes');
const correspondentRouter = require('../features/correspondent/correspondent.routes');
const integrationRegistryRouter = require('../features/integrations/registry/registry.routes');
require('../features/integrations/errors'); // liga o repórter de credencial vencida (M9-D207)
const integrationErrorsRouter = require('../features/integrations/errors/errors.routes');
const integrationAdminRouter = require('../features/integrations/admin/admin.routes');
const integrationActionsRouter = require('../features/integrations/admin/actions/actions.routes');
const integrationContingencyRouter = require('../features/integrations/contingency/contingency.routes');
const { catalogRouter: integrationCatalogRouter } = require('../features/integrations');
const correspondentWebhooksController = require('../features/correspondent/webhooks.controller');
const insuranceController = require('../features/procurement/insurance.controller');
const { webhooks: integrationWebhooks } = require('../features/integrations');
const auditRouter = require('../features/audit/audit.routes');
const billingRouter = require('../features/billing/billing.routes');
const settingsRouter = require('../features/settings/settings.routes');
const filesRouter = require('../features/files/files.routes');
const { router: governanceRouter, viewPolicyRouter } = require('../features/core-governance');
const { router: aiModuleRouter } = require('../features/ai');
const { router: marketingModuleRouter, publicRouter: marketingPublicRouter } = require('../features/marketing');
const { router: analyticsModuleRouter } = require('../features/analytics');
const { rateLimitMiddleware } = require('../features/core-governance/api-governance/standards');
const { deprecationMiddleware } = require('../features/core-governance/api-governance/consumers');

/**
 * Agregador único de rotas da API.
 * Toda nova feature deve ser montada aqui — nenhuma outra parte do código
 * deve registrar rotas diretamente no app Express.
 */
const router = Router();

// Marco 9 (M9-D843): limite de requisições por credencial, com X-RateLimit-* em toda resposta; o contador está no banco e vale entre processos.
router.use(rateLimitMiddleware);
// Marco 9 (M9-D841): deprecação de rota ou major nas respostas (Deprecation, Sunset, Link; 410 após o desligamento) e rastro de uso por consumidor.
router.use(deprecationMiddleware);

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
// Marco 9 (M9-D211): a rota única POST /v1/webhooks/:provider/:channel (e o alias da raiz) e os aliases abaixo passam pelo mesmo framework: corpo bruto e limite WEBHOOK compartilhado.
router.use(integrationWebhooks.router);
router.post('/v1/legal/webhooks/clicksign', ...integrationWebhooks.legacyAlias('clicksign', legalController.clicksignPublicWebhook));
// Mesmo motivo acima, pro webhook do provider bancário (PROVIDER_BANCARIO.md) — resolve o
// tenant via BankPaymentProviderRouting (sem RLS), nunca via JWT (o banco não tem um).
router.post('/v1/finance/webhooks/bank-payment', ...integrationWebhooks.legacyAlias('bank-payment', financeController.bankPaymentPublicWebhook));
// Mesmo motivo acima, pro webhook de seguradora (Insurance Hub, Marco 7) — resolve o tenant via
// InsuranceProviderSubmission (sem RLS).
router.post('/v1/procurement/webhooks/insurance', ...integrationWebhooks.legacyAlias('insurance', insuranceController.insurancePublicWebhook));
// Marco 8 Fase 6 — webhook de financiamento. Path segue a API mínima literal do Caderno
// ("POST /webhooks/financing/:provider"), prefixado com /v1/correspondent como os demais.
// Limite WEBHOOK por IP/provider (contador compartilhado) antes de qualquer consulta ao banco (webhook público, sem login).
router.post('/v1/correspondent/webhooks/financing/:provider', ...integrationWebhooks.legacyAlias((req) => req.params.provider, correspondentWebhooksController.financingPublicWebhook));
// Carrinho de imóveis compartilhável (crm.carts, item 3) — link PÚBLICO, sem JWT (quem recebe
// o link é um lead/cliente final, não um usuário do sistema). Resolve o tenant via
// CartShareRouting (sem RLS), mesmo padrão dos webhooks acima.
router.get('/v1/crm/carts/public/:token', crmController.getPublicCart);
router.post('/v1/crm/carts/public/:token/properties/:propertyId/click', crmController.clickPublicCartProperty);
// Marketing — link de rastreio público GET /t/:shortCode (M9-D431): 302 com UTMs, assinatura do link como autorização.
router.use(marketingPublicRouter);

// Rotas de domínio versionadas.
router.use('/v1', pingRouter);
// Marco 9 (M9-D825) — política de DLP para VIEW: envolve a resposta JSON das rotas de pessoas, imóveis, fornecedores, contratos, financeiro e arquivos (caminho por escopo).
router.use('/v1', viewPolicyRouter);
// Marco 9 — governança (src/features/core-governance). Montado ANTES dos routers de feature: o envelope de erro (error.traceId) e a
// autenticação valem só nos prefixos do bloco (nenhum router.use sem caminho), então as demais rotas de /v1 não são afetadas.
router.use('/v1', governanceRouter);
// Marco 9 (M9-D852) — rotas /impact das ações destrutivas do inventário (src/shared/destructive-actions); autenticação e permissão em cada rota, sem router.use global.
router.use('/v1', require('../shared/destructive-actions/impact.routes'));
// Marco 9 — NAY (src/features/ai, M9-D003): /v1/ai/*, auth/tenant só sob /ai, chave geral ia.habilitada no aiGate.
router.use('/v1', aiModuleRouter);
// Marco 9 — Marketing (src/features/marketing, M9-D402): /v1/marketing/*, auth/tenant só sob /marketing, permissões marketing:*.
router.use('/v1', marketingModuleRouter);
// Marco 9 — BI (src/features/analytics, M9-D612): /v1/analytics/*, GET em transação somente leitura e 405 em escrita de métrica/dashboard.
router.use('/v1', analyticsModuleRouter);
router.use('/v1', authRouter);
router.use('/v1', groupsRouter);
router.use('/v1', companiesRouter);
router.use('/v1', unitsRouter);
router.use('/v1', usersRouter);
router.use('/v1', membershipsRouter);
router.use('/v1', rolesRouter);
router.use('/v1', peopleRouter);
router.use('/v1', propertiesRouter);
router.use('/v1', portalListingsRouter);
router.use('/v1', crmRouter);
router.use('/v1', radarRouter);
router.use('/v1', financeRouter);
router.use('/v1', financeExportRouter);
router.use('/v1', legalRouter);
router.use('/v1', constructionRouter);
router.use('/v1', inventoryRouter);
router.use('/v1', inventoryNayRouter);
router.use('/v1', procurementRouter);
router.use('/v1', correspondentRouter);
router.use('/v1', integrationRegistryRouter);
router.use('/v1', integrationErrorsRouter);
router.use('/v1', integrationContingencyRouter);
router.use('/v1', integrationActionsRouter);
router.use('/v1', integrationAdminRouter);
router.use('/v1', integrationCatalogRouter);
router.use('/v1', auditRouter);
router.use('/v1', billingRouter);
router.use('/v1', settingsRouter);
router.use('/v1', filesRouter);

module.exports = router;
