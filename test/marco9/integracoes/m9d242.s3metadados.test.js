'use strict';

// Marco 9, M9-D242 (reabertura R3-M3) — o destino S3 nunca trata metadados de nuvem nem IP proibido como rede própria, mesmo que o valor gravado em
// integration.egress.private_hosts os traga. Funções puras, sem banco.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { s3ConfigProblems } = require('../../../src/features/integrations/providers/storage/storage.s3.target');

test('m3_s3_nao_trata_como_rede_propria_metadados_nem_ip_proibido_mesmo_que_o_valor_gravado_os_traga', () => {
  const lista = ['metadata.google.internal', 'kubernetes.default.svc', '169.254.169.254', '168.63.129.16', '127.0.0.1', 'minio.empresa.lan', '10.0.0.5'];
  const problemas = (endpoint) => s3ConfigProblems({ endpoint, bucket: 'nayara-docs', pathStyle: true }, { privateHosts: lista });
  for (const endpoint of lista.slice(0, 5)) assert.ok(problemas(endpoint).some((p) => p.startsWith('endpoint:')), endpoint);
  for (const endpoint of lista.slice(5)) assert.deepEqual(problemas(endpoint), [], endpoint);
});
