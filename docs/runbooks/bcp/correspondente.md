# Runbook de continuidade — Correspondente bancário

Roteiro impresso para operar **sem o sistema** no setor de Correspondente bancário e lançar tudo depois sem perder nada. Formulários do setor: PROTOCOLO_DOCUMENTO (intenção `REGISTER_DOCUMENT`) e ANDAMENTO_PROCESSO (intenção `REGISTER_CASE_PROGRESS`). Prefixo da numeração: `COR` (número `COR-AAAA-nnnnn`, impresso no papel).

## 1. Quando acionar
O sistema está indisponível e o responsável do setor decide acionar a contingência. Anote a hora de início no primeiro formulário. Não acione por lentidão: só por indisponibilidade que impeça o trabalho.

## 2. Quem aciona e quem é o responsável
- Aciona e responde: Responsável do correspondente (substituto: o analista sênior de processos).
- O responsável avisa a equipe, distribui os blocos numerados e controla a faixa de números usada.

## 3. O que continua funcionando sem o sistema
Receber documentos dos clientes, protocolar na instituição financeira e acompanhar andamento pela via do banco.

## 4. Passo a passo manual
1. Para cada documento recebido ou entregue, preencha o formulário **PROTOCOLO_DOCUMENTO** (número `COR-AAAA-nnnnn`): processo, tipo, quem entregou, quem recebeu, data e classificação.
2. Cada mudança de situação do processo vai no formulário **ANDAMENTO_PROCESSO**: processo, etapa, situação e data.
3. Documento com dado pessoal fica em pasta fechada, com acesso só do responsável.
4. Fotografe a folha preenchida (evidência do registro).

## 5. O que é proibido fazer manualmente
- Entregar documento do cliente a terceiro sem autorização escrita.
- Informar aprovação de crédito antes da confirmação do banco.
- Copiar documentos para meios pessoais.

## 6. Como registrar para reconciliação
- Cada formulário tem seu número `COR-AAAA-nnnnn`; esse número é a ponte com o sistema e nunca se repete.
- Fotografe ou escaneie cada folha preenchida: a imagem é a evidência obrigatória do registro (`POST /bcp/manual-operations`).
- Folhas do mesmo caso compartilham a mesma referência de correlação (`correlationRef`), informada ao registrar.
- Use o campo de valores em centavos, inteiros, sem vírgula nem ponto.

## 7. Como encerrar a contingência e importar
1. Com o sistema de volta, o responsável confere se todas as folhas usadas têm foto e número.
2. Quem tem permissão do setor registra cada folha em `POST /bcp/manual-operations`; folha com dado errado fica registrada com o erro e é corrigida em `PATCH /bcp/manual-operations/:id`.
3. A importação para o sistema e a conciliação seguem o procedimento de importação do BCP (M9-D832). Só depois dela o responsável registra o fim da contingência (hora de término) e arquiva as folhas originais.
