'use strict';

// M9-D613 — API pública da camada briefs do BI. As demandas do Marco 9 acrescentam aqui o que a camada expõe.
// M9-D695: ferramentas da NAY Diretoria (catálogo fechado de leitura, guarda contra consulta livre, serviço).
module.exports = { camada: 'briefs', ...require('./nayTools') };
