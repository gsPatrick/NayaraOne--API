'use strict';
/**
 * Captura do fechamento do Marco 5 — Jurídico, cadeia de custódia e dossiê de provas (Caderno M5
 * §16, §19, JUR-010/011, JUR-TS-010/011, Guia §13/§14). A exportação passa pelo guard da DLP: o
 * dossiê de arquivos HIGH exige finalidade, justificativa e MFA (recusa real capturada por HTTP; a
 * exportação em si é provada pela camada de serviço, sem forjar MFA).
 */
const { q, sufixo, arquivo } = require('../juridico-apoio');

module.exports = async function juridicoDossie(R) {
  const s = sufixo();
  const H = (o) => R.http(o);
  const evidence = require('../../../src/modules/legal/cases/evidence-package.service');
  const legalHold = require('../../../src/features/core-governance/data-quality/legalHold.guard');
  const { rejectRestrictedUnlessAllowed } = require('../../../src/features/files/restrictedDocument.guard');
  const files = require('../../../src/features/files/files.service');
  if (!R.tokens['A:mascarado']) await R.login('A', 'mascarado'); // perfil do seed SEM legal:read (login normal)

  await H({ id: 'JR-E01', req: q('A0103'), titulo: 'Preparação: processo do dossiê', quem: 'A:gestor', metodo: 'POST', rota: '/legal/cases', corpo: { caseType: 'LITIGATION', caseNumber: `DS-${s}` }, esperado: { status: 201 }, guardar: (b, c) => { c.dsCaso = b.data.id; } });
  await H({ id: 'JR-E02', req: q('A0113', 'A0307', 'A0116'), titulo: 'Envia a foto original da prova (SHA-256 calculado pelo servidor no upload)', quem: 'A:gestor', metodo: 'POST', rota: '/files', corpo: arquivo(`foto-original-${s}.pdf`, `Foto original fictícia ${s}`), esperado: { status: 201 }, guardar: (b, c) => { c.dsOriginal = b.data.id; } });
  await H({ id: 'JR-E03', req: q('A0116'), titulo: 'Versão derivada (recorte) é enviada como OUTRO arquivo; o original não é regravado', quem: 'A:gestor', metodo: 'POST', rota: '/files', corpo: arquivo(`foto-recorte-${s}.pdf`, `Foto original fictícia ${s} (recorte com contraste)`), esperado: { status: 201 }, guardar: (b, c) => { c.dsDerivada = b.data.id; } });
  await H({ id: 'JR-E04', req: q('A0103', 'A0307'), titulo: 'Liga a foto original ao processo como prova', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.dsCaso}/documents`, corpo: (c) => ({ fileId: c.dsOriginal, purpose: 'EVIDENCE' }), esperado: { status: 201 } });
  await R.sqlTenant({
    id: 'JR-E05', req: q('A0113', 'A0116', 'A0259'), quem: 'A:gestor', descricao: 'Original e derivada são linhas separadas, cada uma com seu SHA-256; nenhuma foi apagada',
    sql: 'SELECT id, file_name, checksum_sha256, size_bytes, deleted_at IS NULL AS ativo FROM people.files WHERE id IN (:a, :b) ORDER BY created_at',
    replacements: (c) => ({ a: c.dsOriginal, b: c.dsDerivada }),
    avaliar: (rows) => rows.length === 2 && rows.every((r) => /^[0-9a-f]{64}$/.test(r.checksum_sha256) && r.ativo) && rows[0].checksum_sha256 !== rows[1].checksum_sha256,
  });
  await H({ id: 'JR-E06', req: q('A0113'), titulo: 'O original continua sendo servido íntegro (conteúdo conferido com o SHA-256 a cada leitura)', quem: 'A:gestor', metodo: 'GET', rota: (c) => `/files/${c.dsOriginal}/content`, esperado: { status: 200 } });

  // ---------- Gerar dossiê ----------
  await H({ id: 'JR-E07', req: q('A0219', 'A0174', 'A0272'), titulo: 'Dossiê sem itens é recusado (rota literal do Guia §14)', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.dsCaso}/evidence-package`, corpo: {}, esperado: { status: 400, codigo: 'LEGAL_EVIDENCE_PACKAGE_VALIDATION' } });
  await H({ id: 'JR-E08', req: q('A0219', 'A0177'), titulo: 'Perfil só de leitura não gera dossiê', quem: 'A:leitura', metodo: 'POST', rota: (c) => `/legal/cases/${c.dsCaso}/evidence-package`, corpo: { manifestItems: [{ type: 'NOTE', description: 'x' }] }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({
    id: 'JR-E09', req: q('A0219', 'A0114', 'A0207', 'A0174', 'A0272', 'A0113', 'A0231', 'A0141', 'A0273'), titulo: 'Gera dossiê (POST /legal/cases/:id/evidence-package): o item com fileId leva hash, nome, data e origem do SERVIDOR; o hash enviado pelo cliente é ignorado',
    quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.dsCaso}/evidence-package`,
    corpo: (c) => ({ manifestItems: [{ type: 'PHOTO', description: 'Foto original do dano', fileId: c.dsOriginal, hash: 'hash-inventado-pelo-cliente' }, { type: 'NOTE', description: 'Nota do perito (sem arquivo)' }] }),
    esperado: { status: 201 }, guardar: (b, c) => { c.dsPacote = b.data.id; c.dsPacoteHash = b.data.packageHash; },
  });
  await H({ id: 'JR-E10', req: q('A0114', 'A0207', 'A0103', 'A0174'), titulo: 'Dossiê automático: todo documento ligado ao processo entra com arquivo, hash, origem, data e relação', quem: 'A:maker', metodo: 'POST', rota: (c) => `/legal/cases/${c.dsCaso}/evidence-packages/auto`, corpo: {}, esperado: { status: 201 }, guardar: (b, c) => { c.dsPacoteAuto = b.data.id; } });
  await H({ id: 'JR-E11', req: q('A0219'), titulo: 'Lista os dossiês do processo', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/cases/${c.dsCaso}/evidence-packages`, esperado: { status: 200 } });
  await R.sqlTenant({
    id: 'JR-E12', req: q('A0114', 'A0207', 'A0141', 'A0231', 'A0273'), quem: 'A:gestor', descricao: 'Manifesto gravado (JSONB) com hash do servidor, nome, data, origem e relação; package_hash SHA-256; eventos evidence.package.created',
    sql: `SELECT p.id, p.package_hash, jsonb_array_length(p.manifest_json) AS itens, p.manifest_json->0->>'hash' AS hash_item, f.checksum_sha256 AS hash_arquivo,
            p.manifest_json->0->>'originalName' AS nome, p.manifest_json->0->>'createdAt' AS data, p.manifest_json->0->>'source' AS origem,
            (SELECT array_agg(o.event_type ORDER BY o.event_type) FROM integration.outbox_events o WHERE o.aggregate_id = p.id) AS eventos
          FROM legal.evidence_packages p JOIN people.files f ON f.id = :file WHERE p.id IN (:a, :b) ORDER BY p.created_at`,
    replacements: (c) => ({ a: c.dsPacote, b: c.dsPacoteAuto, file: c.dsOriginal }),
    avaliar: (rows) => rows.length === 2 && rows.every((r) => r.hash_item === r.hash_arquivo && r.nome && r.data && r.origem && /^[0-9a-f]{64}$/.test(r.package_hash) && (r.eventos || []).includes('evidence.package.created')),
  });

  // ---------- Acesso, exportação e custódia ----------
  await H({ id: 'JR-E13', req: q('A0117'), titulo: 'Leitura humana do dossiê entra na cadeia de custódia (VIEWED)', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/evidence-packages/${c.dsPacote}`, esperado: { status: 200 } });
  await H({ id: 'JR-E14', req: q('A0176', 'A0275', 'A0159', 'A0147'), titulo: 'JUR-TS-011: perfil sem legal:read exporta o dossiê: negado', quem: 'A:mascarado', metodo: 'GET', rota: (c) => `/legal/evidence-packages/${c.dsPacote}/export`, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'JR-E15', req: q('A0159', 'A0177'), titulo: 'JUR-TS-011: tenant B exporta o dossiê de A: não existe', quem: 'B:gestor', metodo: 'GET', rota: (c) => `/legal/evidence-packages/${c.dsPacote}/export`, esperado: { status: 404, codigo: 'LEGAL_EVIDENCE_PACKAGE_NOT_FOUND' } });
  await H({ id: 'JR-E16', req: q('A0159'), titulo: 'JUR-TS-011: anônimo exporta o dossiê: negado', quem: 'anonimo', metodo: 'GET', rota: (c) => `/legal/evidence-packages/${c.dsPacote}/export`, esperado: { status: 401 } });
  await H({ id: 'JR-E17', req: q('A0147', 'A0178', 'A0276'), titulo: 'Dossiê com arquivo HIGH: exportar sem finalidade/justificativa é recusado pela DLP', quem: 'A:gestor', metodo: 'GET', rota: (c) => `/legal/evidence-packages/${c.dsPacote}/export`, esperado: { status: 422, codigo: 'GOV_DLP_PURPOSE_REQUIRED' } });
  await H({ id: 'JR-E18', req: q('A0147', 'A0178', 'A0276'), titulo: 'Com finalidade e justificativa, a exportação ainda exige MFA recente (recusa real, sem forjar MFA)', quem: 'A:gestor', metodo: 'GET', rota: (c) => `/legal/evidence-packages/${c.dsPacote}/export?purpose=JURIDICO&justification=${encodeURIComponent('Entrega do dossiê ao advogado da causa')}`, esperado: { status: 403, codigo: 'MFA_STEP_UP_REQUIRED' } });
  await H({ id: 'JR-E19', req: q('A0219', 'A0115'), titulo: 'Preparação: dossiê só com nota (sem arquivo: classe padrão da empresa)', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.dsCaso}/evidence-packages`, corpo: { manifestItems: [{ type: 'NOTE', description: 'Ata de reunião fictícia' }] }, esperado: { status: 201 }, guardar: (b, c) => { c.dsPacoteNota = b.data.id; } });
  await H({ id: 'JR-E20', req: q('A0147', 'A0159', 'A0178', 'A0276'), titulo: 'Dossiê sem arquivo herda a classe padrão da empresa (HIGH): com a permissão, finalidade e justificativa, falta só o MFA recente (recusa real)', quem: 'A:gestor', metodo: 'GET', rota: (c) => `/legal/evidence-packages/${c.dsPacoteNota}/export?purpose=JURIDICO&justification=${encodeURIComponent('Entrega do dossiê ao advogado da causa')}`, esperado: { status: 403, codigo: 'MFA_STEP_UP_REQUIRED' } });
  await H({ id: 'JR-E20b', req: q('A0147', 'A0159'), titulo: 'Permissão específica: perfil com legal:read mas sem legal:evidence:export não exporta', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/evidence-packages/${c.dsPacoteNota}/export?purpose=JURIDICO&justification=${encodeURIComponent('Entrega do dossiê ao advogado da causa')}`, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await R.servico({
    id: 'JR-E21', req: q('A0115', 'A0117', 'A0178', 'A0276'), titulo: 'Exporta o dossiê duas vezes (camada de serviço, o que a rota entrega após o MFA): export_package_id e export_manifest_hash novos a cada vez, package_hash igual e íntegro',
    chamada: 'evidence.exportEvidencePackage(pacote) x2 + verifyEvidencePackageIntegrity',
    fn: (c) => R.comTenant('A:gestor', async (tx, t) => {
      const e1 = await evidence.exportEvidencePackage(c.dsPacoteNota, t.userId, tx);
      const e2 = await evidence.exportEvidencePackage(c.dsPacoteNota, t.userId, tx);
      const r = { exportPackageIds: [e1.exportPackageId, e2.exportPackageId], exportManifestHashes: [e1.exportManifestHash, e2.exportManifestHash], packageHash: [e1.packageHash, e2.packageHash], integridade: evidence.verifyEvidencePackageIntegrity(e1, e1.packageHash).valid, export1: e1 };
      if (r.exportPackageIds[0] === r.exportPackageIds[1] || r.exportManifestHashes[0] === r.exportManifestHashes[1] || r.packageHash[0] !== r.packageHash[1] || !r.integridade) throw Object.assign(new Error('exportações não diferem'), { code: 'EXPORT_NAO_DIFERE' });
      return r;
    }),
    esperado: {}, guardar: (r, c) => { c.dsExport1 = r.export1; },
  });
  await R.servico({
    id: 'JR-E23', req: q('A0147', 'A0115', 'A0178', 'A0276'), titulo: 'Exportação do dossiê com arquivo HIGH pela camada de serviço (o que a rota entrega depois do MFA): manifesto íntegro contra o hash gravado',
    chamada: 'evidence.exportEvidencePackage(pacote) + verifyEvidencePackageIntegrity(export, package_hash)',
    fn: (c) => R.comTenant('A:gestor', async (tx, t) => {
      const exported = await evidence.exportEvidencePackage(c.dsPacote, t.userId, tx);
      return { exportPackageId: exported.exportPackageId, exportManifestHash: exported.exportManifestHash, itemCount: exported.itemCount, integridade: evidence.verifyEvidencePackageIntegrity(exported, c.dsPacoteHash) };
    }),
    esperado: {},
  });
  await H({ id: 'JR-E24', req: q('A0117', 'A0307', 'A0178', 'A0276'), titulo: 'Cadeia de custódia do dossiê: quem acessou/exportou e quando (append-only)', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/evidence-packages/${c.dsPacoteNota}/access-log`, esperado: { status: 200 } });
  await R.sqlTenant({
    id: 'JR-E25', req: q('A0117', 'A0159'), quem: 'A:gestor', descricao: 'Custódia: VIEWED/EXPORTED com usuário e data; as exportações recusadas (sem permissão, DLP, MFA) não geraram EXPORTED; cada acesso tem auditoria',
    sql: `SELECT l.evidence_package_id = :pkgNota AS do_dossie_nota, l.action, l.accessed_by_user_id IS NOT NULL AS tem_usuario, l.accessed_at::text AS accessed_at,
            (SELECT count(*) FROM audit.audit_log a WHERE a.entity_id = l.id AND a.action = 'legal.evidence_package.access') AS auditorias
          FROM legal.evidence_package_access_log l WHERE l.evidence_package_id IN (:pkg, :pkgNota) ORDER BY l.accessed_at`,
    replacements: (c) => ({ pkg: c.dsPacote, pkgNota: c.dsPacoteNota }),
    avaliar: (rows) => rows.filter((r) => !r.do_dossie_nota && r.action === 'EXPORTED').length === 1 && rows.filter((r) => r.do_dossie_nota && r.action === 'EXPORTED').length === 2 && rows.every((r) => r.tem_usuario && Number(r.auditorias) === 1),
  });
  await R.servico({
    id: 'JR-E26', req: q('A0176', 'A0275', 'A0158', 'A0239', 'A0307'), titulo: 'JUR-TS-010: prova alterada no export (hash de item trocado) → integridade falha contra o hash gravado',
    chamada: 'verifyEvidencePackageIntegrity(export adulterado, package_hash)',
    fn: (c) => {
      const tampered = { ...c.dsExport1, manifest: c.dsExport1.manifest.map((i) => ({ ...i, description: `${i.description} (ADULTERADO)` })) };
      const r = evidence.verifyEvidencePackageIntegrity(tampered, c.dsExport1.packageHash);
      if (r.valid) throw Object.assign(new Error('adulteração não detectada'), { code: 'ADULTERACAO_NAO_DETECTADA' });
      return r;
    },
    esperado: {},
  });

  // ---------- Legal hold ----------
  await H({ id: 'JR-E27', req: q('A0118'), titulo: 'Legal hold sem motivo é recusado', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.dsCaso}/legal-hold`, corpo: { legalHold: true }, esperado: { status: 400, codigo: 'LEGAL_CASE_LEGAL_HOLD_REASON_REQUIRED' } });
  await H({ id: 'JR-E28', req: q('A0118', 'A0308'), titulo: 'Ativa o legal hold do processo', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.dsCaso}/legal-hold`, corpo: { legalHold: true, reason: 'Preservação por litígio fictício' }, esperado: { status: 200 } });
  await H({ id: 'JR-E29', req: q('A0118'), titulo: 'Em hold, encerrar o processo é bloqueado', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/cases/${c.dsCaso}`, corpo: { status: 'CLOSED' }, esperado: { status: 409, codigo: 'LEGAL_CASE_ON_LEGAL_HOLD' } });
  await R.servico({
    id: 'JR-E30', req: q('A0118', 'A0308', 'A0259'), titulo: 'Em hold, o descarte do processo é recusado pela trava jurídica (quem apaga/anonimiza/descarta pergunta aqui)',
    chamada: "legalHold.assertNotOnHold('LEGAL_CASE', processo, tx, tenant)",
    fn: (c) => R.comTenant('A:gestor', (tx, t) => legalHold.assertNotOnHold('LEGAL_CASE', c.dsCaso, tx, t)),
    esperado: { erro: 'GOV_HOLD_BLOCKS_DISPOSAL' },
  });

  // ---------- Documentos restritos (RLS/RBAC/ABAC) ----------
  await H({ id: 'JR-E31', req: q('A0148'), titulo: 'Classificar documento como RESTRITO exige governance:classification:manage (o gestor jurídico não tem)', quem: 'A:gestor', metodo: 'POST', rota: '/files', corpo: arquivo(`laudo-restrito-${s}.pdf`, `Laudo restrito fictício ${s}`, { classification: 'RESTRICTED' }), esperado: { status: 403, codigo: 'GOV_FILE_CLASSIFICATION_FORBIDDEN' } });
  await R.servico({
    id: 'JR-E31b', req: q('A0148'), titulo: 'Preparação: laudo RESTRITO gravado pela camada de serviço (como faria quem tem a permissão de classificar)',
    chamada: "files.uploadFile({classification:'RESTRICTED'}) no contexto do tenant A",
    fn: () => R.comTenant('A:gestor', async (tx, t) => {
      const file = await files.uploadFile({ groupId: t.groupId, companyId: t.companyId, ...arquivo(`laudo-restrito-${s}.pdf`, `Laudo restrito fictício ${s}`), classification: 'RESTRICTED' }, t.userId, tx);
      return { id: file.id, classification: file.classification, checksumSha256: file.checksumSha256 };
    }),
    esperado: {}, guardar: (r, c) => { c.dsRestrito = r.id; },
  });
  await H({ id: 'JR-E32', req: q('A0148'), titulo: 'ABAC: sem governance:dlp:view-restricted o documento restrito não abre', quem: 'A:gestor', metodo: 'GET', rota: (c) => `/files/${c.dsRestrito}/content`, esperado: { status: 403, codigo: 'FILE_RESTRICTED_DOCUMENT' } });
  await H({ id: 'JR-E33', req: q('A0148', 'A0177'), titulo: 'RLS: tenant B não enxerga o documento de A', quem: 'B:gestor', metodo: 'GET', rota: (c) => `/files/${c.dsRestrito}`, esperado: { status: 404 } });
  await R.servico({
    id: 'JR-E34', req: q('A0148'), titulo: 'ABAC: com governance:dlp:view-restricted a regra libera; sem ela recusa (mesma função do download)',
    chamada: 'rejectRestrictedUnlessAllowed(false, permissões, arquivo RESTRICTED)',
    fn: () => {
      const file = { getDataValue: () => 'RESTRICTED' };
      rejectRestrictedUnlessAllowed(false, ['legal:read', 'governance:dlp:view-restricted'], file);
      let negado = null;
      try { rejectRestrictedUnlessAllowed(false, ['legal:read'], file); } catch (err) { negado = err.code; }
      if (negado !== 'FILE_RESTRICTED_DOCUMENT') throw Object.assign(new Error('não recusou'), { code: 'ABAC_FALHOU' });
      return { comPermissao: 'liberado', semPermissao: negado };
    },
    esperado: {},
  });

  // ---------- Prova alterada (hash diverge) e prova original que não se apaga ----------
  await H({ id: 'JR-E35', req: q('A0158', 'A0239', 'A0113'), titulo: 'Preparação: prova enviada (SHA-256 gravado no upload)', quem: 'A:gestor', metodo: 'POST', rota: '/files', corpo: arquivo(`prova-integridade-${s}.pdf`, `Prova de integridade ${s}`), esperado: { status: 201 }, guardar: (b, c) => { c.dsProvaId = b.data.id; c.dsProvaKey = b.data.storageKey; } });
  await H({ id: 'JR-E36', req: q('A0158', 'A0239', 'A0113'), titulo: 'A prova íntegra é servida (conteúdo confere com o SHA-256)', quem: 'A:gestor', metodo: 'GET', rota: (c) => `/files/${c.dsProvaId}/content`, esperado: { status: 200 } });
  await R.servico({
    id: 'JR-E37', req: q('A0158', 'A0239'), titulo: 'Adulteração simulada: um byte do blob da prova trocado no storage local do ambiente descartável',
    chamada: 'fs: inverte o último byte de UPLOADS_ROOT/<storageKey> (só do arquivo enviado em JR-E35)',
    fn: (c) => {
      const fs = require('node:fs');
      const path = require('node:path');
      const { UPLOADS_ROOT } = require('../../../src/utils/diskStorage');
      const target = path.join(UPLOADS_ROOT, c.dsProvaKey);
      const bytes = fs.readFileSync(target);
      bytes[bytes.length - 1] ^= 0xff;
      fs.writeFileSync(target, bytes);
      return { arquivo: c.dsProvaId, bytes: bytes.length };
    },
    esperado: {},
  });
  await H({ id: 'JR-E38', req: q('A0158', 'A0239', 'A0307'), titulo: 'JUR-TS-010 por HTTP: prova alterada — a leitura é recusada (integridade falha) e o incidente é auditado', quem: 'A:gestor', metodo: 'GET', rota: (c) => `/files/${c.dsProvaId}/content`, esperado: { status: 409, codigo: 'FILE_INTEGRITY_VIOLATION' } });
  await H({ id: 'JR-E39', req: q('A0259', 'A0308', 'A0125'), titulo: 'Não existe rota para apagar o dossiê de provas (DELETE recusado)', quem: 'A:gestor', metodo: 'DELETE', rota: (c) => `/legal/evidence-packages/${c.dsPacote}`, esperado: { status: 404 } });
  await H({ id: 'JR-E40', req: q('A0259', 'A0308'), titulo: 'Não existe rota para apagar o arquivo de prova original (DELETE recusado)', quem: 'A:gestor', metodo: 'DELETE', rota: (c) => `/files/${c.dsOriginal}`, esperado: { status: 404 } });
  await H({ id: 'JR-E41', req: q('A0259', 'A0113'), titulo: 'Depois das tentativas de exclusão, a prova original continua lá, com o mesmo SHA-256', quem: 'A:gestor', metodo: 'GET', rota: (c) => `/files/${c.dsOriginal}`, esperado: { status: 200 } });
  await H({ id: 'JR-E42', req: q('A0158', 'A0239', 'A0178', 'A0276'), titulo: 'O dossiê continua com o hash gravado (a verificação de integridade confronta o export com este valor)', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/evidence-packages/${c.dsPacote}`, esperado: { status: 200 } });
};
