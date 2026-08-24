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

/**
 * Agregador único de rotas da API.
 * Toda nova feature deve ser montada aqui — nenhuma outra parte do código
 * deve registrar rotas diretamente no app Express.
 */
const router = Router();

// GET /health — fora do prefixo /v1, usado por health checks de infraestrutura.
router.use('/', healthRouter);

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

module.exports = router;
