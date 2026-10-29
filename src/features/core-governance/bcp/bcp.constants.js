'use strict';

/**
 * Constantes da continuidade operacional (BCP). O catálogo de setores é a tabela governance.bcp_sectors (M9-D830 §3.0, semeada pela migration 817); esta lista é a
 * mesma, em código, para validar sem consulta (o teste m9d830 confere que as duas coincidem).
 */
const SECTORS = Object.freeze([
  { sector: 'ATENDIMENTO', prefix: 'ATD', runbook: 'atendimento.md' },
  { sector: 'LOCACAO', prefix: 'LOC', runbook: 'locacao.md' },
  { sector: 'FINANCEIRO', prefix: 'FIN', runbook: 'financeiro.md' },
  { sector: 'OBRAS', prefix: 'OBR', runbook: 'obras.md' },
  { sector: 'CORRESPONDENTE', prefix: 'COR', runbook: 'correspondente.md' },
  { sector: 'JURIDICO', prefix: 'JUR', runbook: 'juridico.md' },
]);
const SECTOR_CODES = Object.freeze(SECTORS.map((item) => item.sector));
const prefixOf = (sector) => (SECTORS.find((item) => item.sector === sector) || {}).prefix || null;

/** Número do formulário: <PREFIXO>-<AAAA>-<nnnnn> (M9-D831 §3.1; formato único, decisão K7). */
const REFERENCE_PATTERN = /^([A-Z]{3})-(\d{4})-(\d{5})$/;

const STATUS = Object.freeze({ RECORDED: 'RECORDED', IMPORTED: 'IMPORTED', REJECTED: 'REJECTED', RECONCILED: 'RECONCILED' });
const ADMIN_ROLE = 'ADMIN';
const RECORD_PERMISSION = 'governance:bcp:record';
const IMPORT_PERMISSION = 'governance:bcp:import';
const EVIDENCE_CATEGORY = 'generic';
const TIME_ZONE = 'America/Sao_Paulo';

module.exports = { SECTORS, SECTOR_CODES, prefixOf, REFERENCE_PATTERN, STATUS, ADMIN_ROLE, RECORD_PERMISSION, IMPORT_PERMISSION, EVIDENCE_CATEGORY, TIME_ZONE };
