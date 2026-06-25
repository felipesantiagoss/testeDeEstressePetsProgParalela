// Worker de processamento em background (paralelismo: fila + worker).
//
// Processo SEPARADO da API (npm run worker). Consome a tabela fila_notificacoes:
// a API produz jobs ao confirmar adoções; este worker os processa de forma
// independente da requisição HTTP — que já respondeu ao usuário há muito tempo.
//
// Pode-se subir VÁRIOS workers ao mesmo tempo (WORKER_ID=worker-A npm run worker):
// o FOR UPDATE SKIP LOCKED garante que cada job é entregue a exatamente um worker.
// O job é processado DENTRO de uma transação: se o worker morrer no meio, o
// Postgres faz rollback e o job volta para a fila automaticamente (status 'P').

const pool = require('./src/config/db'); // Importa o pool de conexões com o banco de dados PostgreSQL

const WORKER_ID = process.env.WORKER_ID || `worker-${process.pid}`; // Identificador deste worker (vem da variável de ambiente ou usa o PID do processo)
// Tempo simulado do trabalho pesado (ex: envio de e-mail, geração de certificado).
const TRABALHO_MS = parseInt(process.env.TRABALHO_MS || '1500', 10); // Duração (em ms) do trabalho simulado de cada job, convertida para número inteiro
// Intervalo entre verificações quando a fila está vazia.
const POLL_MS = parseInt(process.env.POLL_MS || '1000', 10); // Tempo (em ms) de espera entre checagens da fila quando não há jobs

let encerrando = false; // Sinaliza quando o worker deve parar (encerramento gracioso)

const hora = () => new Date().toTimeString().slice(0, 8); // Função auxiliar que retorna a hora atual no formato HH:MM:SS
const log = (msg) => console.log(`[${hora()}] [${WORKER_ID}] ${msg}`); // Função de log que imprime a hora, o id do worker e a mensagem
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); // Função auxiliar que pausa a execução por 'ms' milissegundos (promessa resolvida via setTimeout)

// Executa o trabalho de um job. Aqui o "envio de e-mail" é simulado com uma
// espera; numa evolução real entraria o nodemailer, push notification etc.
async function executarJob(job) {
  const { nome, usuarioId, animalId } = job.payload; // Extrai os dados guardados no payload do job
  if (job.tipo === 'adocao_confirmada') { // Se o job é de confirmação de adoção
    await sleep(TRABALHO_MS); // Simula o tempo de envio do e-mail (trabalho pesado)
    log(`📧 e-mail de confirmação enviado para "${usuarioId}": parabéns pela adoção de ${nome} (pet ${animalId})`); // Registra no log o "envio" do e-mail
  } else { // Para qualquer outro tipo de job
    await sleep(TRABALHO_MS); // Simula o tempo de processamento
    log(`job de tipo "${job.tipo}" processado`); // Registra no log que o job genérico foi processado
  }
}

// Pega 1 job pendente e processa. Retorna 'job', 'vazia' ou 'erro'.
async function processarProximoJob() {
  let client; // Conexão que será obtida do pool
  try {
    client = await pool.connect(); // Obtém uma conexão dedicada do pool
    await client.query('BEGIN'); // Inicia uma transação no banco

    // SKIP LOCKED: se outro worker já travou um job, este pula para o próximo
    // em vez de esperar — é isso que permite consumo em paralelo sem duplicar.
    const { rows } = await client.query(
      `SELECT id, tipo, payload, criado_em
         FROM fila_notificacoes
        WHERE status = 'P'
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT 1`
    ); // Busca o job pendente ('P') mais antigo, travando-o e ignorando os já travados por outros workers

    // Se não há nenhum job pendente disponível
    if (rows.length === 0) {
      await client.query('COMMIT'); // Encerra a transação vazia
      return 'vazia'; // Sinaliza que a fila está vazia
    }

    const job = rows[0]; // Pega o job retornado pela consulta
    log(`📬 job #${job.id} recebido (${job.tipo}) — processando...`); // Registra no log que o job começou a ser processado
    await executarJob(job); // Executa o trabalho do job

    // clock_timestamp() = instante real da conclusão (now() devolveria o início
    // da transação, que fica aberta durante todo o processamento do job).
    // Marca o job como concluído ('C'), gravando quando e por qual worker foi processado
    await client.query(
      `UPDATE fila_notificacoes
          SET status = 'C', processado_em = clock_timestamp(), processado_por = $1
        WHERE id = $2`,
      [WORKER_ID, job.id] // Parâmetros: id deste worker e id do job concluído
    );
    await client.query('COMMIT'); // Confirma a transação, efetivando a conclusão do job
    log(`✅ job #${job.id} concluído`); // Registra no log que o job foi concluído com sucesso
    return 'job'; // Sinaliza que um job foi processado
  } catch (err) {
    // Banco fora do ar ou erro no job: o worker NÃO morre — loga, espera e
    // tenta de novo. Se havia job em andamento, o rollback o devolve à fila.
    if (client) await client.query('ROLLBACK').catch(() => {}); // Desfaz a transação para devolver o job à fila (ignora erro do próprio rollback)
    // Determina uma mensagem de erro legível, testando várias fontes possíveis
    const motivo =
      err.message || err.code || (err.errors && err.errors[0] && err.errors[0].message) || String(err);
    log(`❌ erro: ${motivo} (se havia job em andamento, ele voltou para a fila)`); // Registra o erro no log
    if (/fila_notificacoes/.test(motivo)) { // Se o erro menciona a tabela da fila
      log('   → a tabela fila_notificacoes existe? Aplique o create-table.sql no banco petz.'); // Dá uma dica de como resolver
    }
    await sleep(POLL_MS); // Aguarda antes de tentar novamente, para não sobrecarregar
    return 'erro'; // Sinaliza que ocorreu um erro
  } finally {
    if (client) client.release(); // Sempre devolve a conexão ao pool, se ela foi obtida
  }
}

// Função principal: laço que mantém o worker consumindo a fila continuamente
async function main() {
  log(`worker iniciado — aguardando jobs na fila (trabalho simulado: ${TRABALHO_MS}ms por job)`); // Loga o início do worker
  let filaVaziaAvisada = false; // Controla para não repetir o aviso de "fila vazia" a cada checagem

  while (!encerrando) { // Repete enquanto o worker não estiver encerrando
    const resultado = await processarProximoJob(); // Tenta processar o próximo job da fila
    if (resultado === 'job') { // Se um job foi processado
      filaVaziaAvisada = false; // Reseta o controle para avisar novamente quando a fila esvaziar
    } else if (resultado === 'vazia') { // Se a fila estava vazia
      if (!filaVaziaAvisada) { // Avisa só uma vez que a fila está vazia
        log('📭 fila vazia — aguardando novos jobs...'); // Loga que está aguardando jobs
        filaVaziaAvisada = true; // Marca que o aviso já foi dado
      }
      await sleep(POLL_MS); // Espera o intervalo de polling antes de checar de novo
    }
    // 'erro': já logou e já esperou dentro do catch — só tenta de novo.
  }

  log('encerrado.'); // Loga o encerramento do worker
  await pool.end(); // Fecha o pool de conexões com o banco
  process.exit(0); // Encerra o processo com código de sucesso
}

// Encerramento gracioso (thread/processo COM controle): termina o job atual e
// só então sai. Se for morto à força no meio de um job, o rollback da transação
// devolve o job à fila — nenhum trabalho se perde.
// Captura o sinal SIGINT (Ctrl+C) para encerrar de forma graciosa
process.on('SIGINT', () => {
  log('SIGINT recebido — terminando o job atual antes de sair...'); // Loga que recebeu o pedido de parada
  encerrando = true; // Sinaliza ao laço principal que deve parar após o job atual
});
// Captura o sinal SIGTERM (pedido de término pelo sistema) para encerrar graciosamente
process.on('SIGTERM', () => {
  encerrando = true; // Sinaliza ao laço principal que deve parar
});

// Inicia o worker e trata qualquer erro fatal não capturado
main().catch(async (err) => {
  log(`❌ erro fatal: ${err.message}`); // Loga o erro fatal
  await pool.end().catch(() => {}); // Tenta fechar o pool de conexões (ignora falhas)
  process.exit(1); // Encerra o processo com código de erro
});
