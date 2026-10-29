'use strict';

/**
 * M9-D617 — read models de Locação (schema analytics, um arquivo por tabela em locacao/): contratos, vacância, inadimplência, garantias,
 * obrigações, vistorias e chaves, chamados, satisfação e repasses. Só ids e agregados: nome e documento de pessoa nunca entram aqui.
 * Quem lê são os serviços de métrica (M9-D613); o worker (M9-D607) aplica o ESTADO recalculado do agregado, idempotente por sourceEventId.
 */
module.exports = {
  contracts: require('./locacao/contracts'),
  vacancy: require('./locacao/vacancy'),
  arrears: require('./locacao/arrears'),
  guarantees: require('./locacao/guarantees'),
  obligations: require('./locacao/obligations'),
  inspectionsKeys: require('./locacao/inspections-keys'),
  tickets: require('./locacao/tickets'),
  satisfaction: require('./locacao/satisfaction'),
  repasses: require('./locacao/repasses'),
};
