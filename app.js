'use strict';

require('dotenv').config();

const express = require('express');
const routes = require('./src/routes');
const errorHandler = require('./src/middlewares/errorHandler');
const { startRadarMatchingJob } = require('./src/engines/jobs/radarMatchingJob');

const app = express();

// Middlewares globais.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const apiPrefix = process.env.APP_API_PREFIX || '/api';

app.use(apiPrefix, routes);

// Rota raiz simples — não substitui /health, apenas facilita smoke test manual.
app.get('/', (req, res) => {
  res.status(200).json({ success: true, data: { name: 'Nayara One API', apiPrefix } });
});

// Error handler global — deve ser o último middleware montado.
app.use(errorHandler);

const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Nayara One API ouvindo na porta ${port} (prefixo ${apiPrefix})`);
});

// Job periódico de matching do Radar — não roda em ambiente de teste (evita efeitos
// colaterais/timers pendurados em test runners que importam este arquivo).
if (process.env.NODE_ENV !== 'test' && process.env.RADAR_MATCHING_JOB_DISABLED !== 'true') {
  startRadarMatchingJob();
}

module.exports = app;
