'use strict';

const { Router } = require('express');
const contentRoutes = require('./content.routes');
const templateRoutes = require('./template.routes');
const service = require('./content.service');
require('./registerConsumers'); // M9-D405: consumidores property.updated / property.price.changed

// A área "content" também serve os templates (I3): as duas famílias de rota ficam no mesmo router da área.
const router = Router();
router.use(contentRoutes);
router.use(templateRoutes);

module.exports = { router, service };
