'use strict';

const net = require('node:net');

/**
 * Regras de nome de host da lista de saída (M9-D245, reabertura G2/M3). Funções puras: valem para o que o administrador digita em
 * `policy.egressHosts` e para o parâmetro de hosts por fornecedor. IP, nome de rede interna e nome sem domínio público nunca entram.
 */
const HOST = /^(?:\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const INTERNAL_SUFFIXES = Object.freeze(['.local', '.localhost', '.internal', '.localdomain', '.lan', '.intranet', '.corp', '.home', '.svc', '.cluster']);
const MAX_HOSTS = 20;

/** true para nome que aponta para rede interna ou que não é um domínio público (último rótulo só com dígitos inclui "127.1" e "2130706433"). */
function isInternalOrNumericName(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || net.isIP(h)) return true;
  if (INTERNAL_SUFFIXES.some((s) => h.endsWith(s))) return true;
  const ultimo = h.split('.').pop();
  return /^[0-9]+$/.test(ultimo) || /^0x[0-9a-f]*$/.test(ultimo);
}

/** null quando o padrão ('api.x.com' ou '*.x.com') é aceitável; senão a mensagem do problema. */
function hostPatternProblem(pattern) {
  if (typeof pattern !== 'string') return 'esperado um nome de host em texto';
  const p = pattern.trim().toLowerCase();
  if (!p || p.length > 253) return 'nome de host vazio ou longo demais';
  if (net.isIP(p.replace(/^\[|\]$/g, ''))) return 'endereço IP não é aceito: use o nome do host';
  if (!HOST.test(p)) return 'nome de host inválido (sem esquema, porta, caminho ou espaço)';
  if (isInternalOrNumericName(p.replace(/^\*\./, ''))) return 'nome de rede interna não é aceito';
  return null;
}

/** Problemas de uma lista de hosts de saída (vazia = válida). */
function validateEgressHostList(lista) {
  if (lista === undefined) return [];
  if (!Array.isArray(lista)) return ['egressHosts: esperada uma lista de nomes de host'];
  const problemas = [];
  if (lista.length > MAX_HOSTS) problemas.push(`egressHosts: no máximo ${MAX_HOSTS} hosts`);
  lista.forEach((h, i) => { const p = hostPatternProblem(h); if (p) problemas.push(`egressHosts[${i}]: ${p}`); });
  return problemas;
}

module.exports = { HOST, MAX_HOSTS, isInternalOrNumericName, hostPatternProblem, validateEgressHostList };
