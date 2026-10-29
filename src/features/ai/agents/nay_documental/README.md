# NAY Documental (M9-D040)

Agente da NAY para os documentos da empresa: **OCR, classificação, extração e checagem**, sempre como **sugestão para revisão humana**. Nunca grava no cadastro, nunca aprova documento, só lê arquivo da empresa já verificado pelo antivírus e nunca guarda o texto completo fora do índice autorizado.

## Arquivos

- `definition.js`: o cadastro do agente (finalidade, política, allowlist de 5 ferramentas, escopos `files.company_files` e `documents.field_models`, `max_tool_calls_por_run=5`). Gravado por `../kit` (`provisionAgentVersion` cria a versão da empresa em DRAFT e desabilitada; `applySystemDefinition`, pelo `scripts/ai/seedSystemAgents.js`, aplica ao padrão do sistema). Agente de alto impacto: a ativação exige a avaliação golden + adversarial verde e homologada por uma pessoa.
- `files.js`: abre o arquivo para a NAY, nesta ordem e parando na primeira recusa: existe na empresa (404 `AI_CROSS_COMPANY_BLOCKED`), foi verificado pelo antivírus (`scan_status = CLEAN`, senão 422 `AI_DOCUMENT_NOT_VERIFIED` e nada é lido), a pessoa pode lê-lo pelo módulo dono (`fileAccess.service.js`, 403 `AI_PERMISSION_DENIED`) e documento restrito só com `ai:restricted`.
- `transcribe.js`: texto do arquivo. PDF, Word e texto simples pela camada de texto do próprio arquivo (sem provedor e sem custo); imagem pela capacidade `vision` e áudio por `transcribe` do provedor de IA (registro de provedores, com o orçamento do agente).
- `classify.js`: tipo sugerido por regra sobre o vocabulário da empresa (`ia.documental.tipos_documento`), com confiança e evidências; sem termo nenhum é OTHER com confiança 0.
- `extract.js`: `ProposedExtraction` pelo OCR do projeto (o mesmo adapter dos documentos de pessoa e da nota de estoque): cada campo com valor em texto, confiança e fonte (arquivo e página). Ilegível vira pendência, nenhum campo inventado.
- `check.js`: aponta, sem corrigir: campo obrigatório ausente, CPF/CNPJ inválido, data inválida ou incoerente, documento vencido, campo de baixa confiança e divergência contra o que a pessoa informou como esperado.
- `suggestion.js`: toda ação sugerida vira uma recomendação `DOCUMENT_EXTRACTION` ou `DOCUMENT_CLASSIFICATION` PENDING dirigida a quem perguntou; aceitar só a marca como vista.
- `services.js`: o serviço `documents` que as ferramentas `documents.*` (em `tools/definitions`) chamam.
- `boundary.js`: fronteira (recusa 200 de pedido fora do propósito e das quatro proibições) e troca da resposta do modelo que afirma ter gravado, aprovado ou guardado algo.
- `golden.js`, `documental.settings.js` (parâmetros `ia.documental.*`), `documental.errors.js`, `vocabulary.js`.

## Como testar

`test/marco9/ia/m9d040.*.test.js` (banco descartável, ver `scripts/withDisposableDb.js`).
