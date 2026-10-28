'use strict';

/** M9-D434 — eventos de Marketing: catálogo do livro, publicador transacional com envelope e consumo idempotente. */
module.exports = {
  ...require('./marketing.events.catalog'),
  ...require('./marketing.events.validate'),
  ...require('./marketing.events.forbidden'),
  ...require('./marketing.events.publish'),
  ...require('./marketing.events.consume'),
};
