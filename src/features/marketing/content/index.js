'use strict';

const { Router } = require('express');
const contentRoutes = require('./content.routes');
const templateRoutes = require('./template.routes');
const service = require('./content.service');
const approval = require('./approval.guard');
require('./registerConsumers'); // M9-D405: consumidores property.updated / property.price.changed

// A área "content" também serve os templates (I3): as duas famílias de rota ficam no mesmo router da área.
const router = Router();
router.use(contentRoutes);
router.use(templateRoutes);

// `approval` é a interface que as outras áreas usam para conferir a aprovação (ex.: campanhas, M9-D412).
// M9-D427: `publicReadModel` e `factual` são a interface que a área de publicações usa para a página pública (SEO) sem importar caminho interno.
const publicReadModel = require('./publicReadModel');
const factual = { validateAgainstFacts: require('./pipeline.factualPort').validateAgainstFacts, readFactualConfig: require('./factual/settings').readFactualConfig };
// M9-D410: a área de publicações registra aqui o agendamento dos jobs (porta), sem a área de conteúdo importá-la.
const schedulePort = require('./pipeline.schedulePort');
module.exports = { router, service, approval, publicReadModel, factual, schedulePort };
