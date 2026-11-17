'use strict';

// Risco e valor estimado do processo são obrigatórios na criação (M5:244, legalCaseRequired.js). Os testes que não
// tratam desses campos abrem o processo com este padrão: risco médio e valor 0 (aceito, DI-BI2-1). Quem precisa de
// outro valor sobrescreve depois do spread: createLegalCase({ ...PROCESSO_PADRAO, riskLevel: 'LOW', ... }).
const PROCESSO_PADRAO = Object.freeze({ riskLevel: 'MEDIUM', estimatedAmount: '0.00' });

module.exports = { PROCESSO_PADRAO };
