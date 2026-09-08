'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const routes = require('./src/routes');
const errorHandler = require('./src/middlewares/errorHandler');
const { startRadarMatchingJob } = require('./src/engines/jobs/radarMatchingJob');

const app = express();

// CORS — permite chamadas do(s) frontend(s) autorizados via CORS_ORIGIN (lista separada por
// vírgula). Sem variável definida, libera geral (uso aceitável em homologação; em produção
// definir CORS_ORIGIN explicitamente com o(s) domínio(s) real(is) do frontend).
const corsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
  })
);

// Middlewares globais.
// `verify` guarda o corpo bruto (Buffer) em `req.rawBody` — necessário para validar a
// assinatura HMAC de webhooks de provedores externos (ex.: assinatura eletrônica) sobre os
// BYTES exatos recebidos, antes de qualquer parsing/normalização do JSON. Não afeta nenhuma
// outra rota: o corpo já parseado (`req.body`) continua disponível normalmente.
app.use(
  express.json({
    limit: '2mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
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
