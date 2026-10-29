# Runbook de continuidade — Obras

Roteiro impresso para operar **sem o sistema** no setor de Obras e lançar tudo depois sem perder nada. Formulários do setor: DIARIO_OBRA (intenção `DAILY_REPORT`) e REQUISICAO_MATERIAL (intenção `MATERIAL_REQUEST`). Prefixo da numeração: `OBR` (número `OBR-AAAA-nnnnn`, impresso no papel).

## 1. Quando acionar
O sistema está indisponível e o responsável do setor decide acionar a contingência. Anote a hora de início no primeiro formulário. Não acione por lentidão: só por indisponibilidade que impeça o trabalho.

## 2. Quem aciona e quem é o responsável
- Aciona e responde: Engenheiro ou mestre de obras responsável (substituto: o encarregado do canteiro).
- O responsável avisa a equipe, distribui os blocos numerados e controla a faixa de números usada.

## 3. O que continua funcionando sem o sistema
A obra segue conforme o cronograma impresso e os projetos em papel; equipe, serviços e compras emergenciais continuam sob o responsável.

## 4. Passo a passo manual
1. No fim de cada dia, preencha o **DIARIO_OBRA** (número `OBR-AAAA-nnnnn`): obra, data, clima, equipe presente, serviços executados, ocorrências e quantidade de fotos.
2. Para pedir material, preencha a **REQUISICAO_MATERIAL** no mesmo prefixo `OBR`: obra, material, quantidade, unidade, urgência e solicitante.
3. Tire as fotos do dia e guarde-as identificadas pelo número da folha.
4. O responsável confere e assina as folhas antes de arquivá-las.

## 5. O que é proibido fazer manualmente
- Comprar material acima do limite do responsável sem autorização escrita.
- Mudar escopo ou projeto sem registro no diário.
- Usar prefixo diferente de `OBR` (não existe `OBR-REQ`).

## 6. Como registrar para reconciliação
- Cada formulário tem seu número `OBR-AAAA-nnnnn`; esse número é a ponte com o sistema e nunca se repete.
- Fotografe ou escaneie cada folha preenchida: a imagem é a evidência obrigatória do registro (`POST /bcp/manual-operations`).
- Folhas do mesmo caso compartilham a mesma referência de correlação (`correlationRef`), informada ao registrar.
- Use o campo de valores em centavos, inteiros, sem vírgula nem ponto.

## 7. Como encerrar a contingência e importar
1. Com o sistema de volta, o responsável confere se todas as folhas usadas têm foto e número.
2. Quem tem permissão do setor registra cada folha em `POST /bcp/manual-operations`; folha com dado errado fica registrada com o erro e é corrigida em `PATCH /bcp/manual-operations/:id`.
3. A importação para o sistema e a conciliação seguem o procedimento de importação do BCP (M9-D832). Só depois dela o responsável registra o fim da contingência (hora de término) e arquiva as folhas originais.
