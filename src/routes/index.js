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
const radarRouter = require('../features/radar/radar.routes');
const financeRouter = require('../features/finance/finance.routes');
const legalRouter = require('../features/legal/legal.routes');
const legalController = require('../features/legal/legal.controller');
const constructionRouter = require('../features/construction/construction.routes');
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
router.use('/v1', auditRouter);
router.use('/v1', billingRouter);
router.use('/v1', settingsRouter);
router.use('/v1', filesRouter);

module.exports = router;
