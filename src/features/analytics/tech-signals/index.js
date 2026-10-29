'use strict';

// M9-D628 — sinais técnicos globais do BI: gravação (sondas, falhas de login e de MFA), medição das sondas e retenção.
module.exports = { ...require('./record'), ...require('./probes') };
