'use strict';

// Apoio da carga das integrações (M9-D255): o ambiente do Dispatch Service (conexões ativas, enfileirar) junto com o dos webhooks (canal assinado, HTTP real).
// Quem usa define process.env.PORT ANTES de requerer este arquivo (ele sobe o app de teste). Roda em banco descartável (COMMITA).
const envDispatch = require('./m9d214Env');
const envWebhook = require('./m9d211Env');

module.exports = { ...envDispatch, ...envWebhook, dispatch: envDispatch.dispatch };
