// Visão rápida da fila de notificações (npm run fila).
// Mostra o resumo por status e os últimos jobs — útil para demonstrar ao vivo
// que a API enfileira (P) e o worker consome em background (C, com autor e tempo).

const pool = require('../src/config/db'); // Importa o pool de conexões com o banco PostgreSQL configurado em src/config/db.js

// Função principal assíncrona que consulta e exibe o estado atual da fila de notificações
async function main() {
  // Executa uma consulta que conta quantos jobs existem em cada status; usa desestruturação para pegar 'rows' e renomear para 'porStatus'
  const { rows: porStatus } = await pool.query(
    // Agrupa os registros por status e conta o total de cada um, ordenando pelo status
    `SELECT status, count(*)::int AS total FROM fila_notificacoes GROUP BY status ORDER BY status`
  );
  // Executa uma consulta que traz os 15 jobs mais recentes com detalhes formatados; renomeia 'rows' para 'jobs'
  const { rows: jobs } = await pool.query(
    // Seleciona id e tipo; extrai 'nome' e 'usuarioId' de dentro do campo JSON 'payload' como pet e adotante
    `SELECT id, tipo, payload->>'nome' AS pet, payload->>'usuarioId' AS adotante,
            status, processado_por,
            to_char(criado_em, 'HH24:MI:SS') AS criado,
            CASE WHEN processado_em IS NOT NULL
                 THEN round(EXTRACT(EPOCH FROM (processado_em - criado_em))::numeric, 1) || 's depois'
                 ELSE '—' END AS processado
       FROM fila_notificacoes
      ORDER BY id DESC
      LIMIT 15`
  );

  const legenda = { P: 'P (pendente)', C: 'C (concluído)', E: 'E (erro)' }; // Mapa que traduz a sigla de cada status para um texto descritivo
  console.log('=== FILA DE NOTIFICAÇÕES (fila_notificacoes) ==='); // Imprime o título do relatório no console
  if (porStatus.length === 0) { // Verifica se não há nenhum registro de status (fila vazia)
    console.log('Fila vazia — nenhuma adoção enfileirou jobs ainda.'); // Avisa que a fila está vazia
  } else {
    // Monta e imprime o resumo: para cada status, mostra a legenda e o total, separados por barras
    console.log('Resumo: ' + porStatus.map((s) => `${legenda[s.status] || s.status}: ${s.total}`).join('  |  '));
    console.log(''); // Imprime uma linha em branco para espaçamento
    console.log('Últimos jobs (mais recente primeiro):'); // Imprime o subtítulo da tabela de jobs
    console.log('  job  | status | pet                  | adotante             | criado   | processado por       | quando'); // Imprime o cabeçalho das colunas
    console.log('  ' + '-'.repeat(105)); // Imprime uma linha separadora com 105 traços
    for (const j of jobs) { // Percorre cada job retornado pela consulta
      // Imprime os dados do job formatados em colunas; padEnd alinha o texto e usa '—' quando o valor está ausente
      console.log(
        `  #${String(j.id).padEnd(4)}| ${j.status}      | ${(j.pet || '—').padEnd(20)} | ${(j.adotante || '—').padEnd(20)} | ${j.criado} | ${(j.processado_por || '— aguardando worker').padEnd(20)} | ${j.processado}`
      );
    }
  }
  await pool.end(); // Encerra o pool de conexões com o banco, liberando os recursos
}

// Executa a função main; se ela lançar algum erro, o callback do catch trata a exceção
main().catch(async (err) => {
  console.error(`Erro ao consultar a fila: ${err.message}`); // Mostra a mensagem de erro ocorrido
  if (/fila_notificacoes/.test(err.message)) { // Verifica se o erro está relacionado à tabela fila_notificacoes
    console.error('A tabela fila_notificacoes existe? Aplique o create-table.sql no banco petz.'); // Dá uma dica de como resolver o problema
  }
  await pool.end().catch(() => {}); // Tenta encerrar o pool de conexões, ignorando qualquer erro nesse fechamento
  process.exit(1); // Encerra o processo com código 1, indicando que houve falha
});
