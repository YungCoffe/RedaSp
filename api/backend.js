export default async function handler(req, res) {
  const { endpoint, params } = req.body; 

  // Mapeamento das suas APIs para evitar expor as URLs originais no seu Frontend
  const baseUrls = {
    'login': 'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/credenciais/api/Login',
    'tarefas': 'https://edusp-api.ip.tv/tms/task/todo',
    'boletim': 'https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/apiboletim/api/Avaliacao/GetAvaliacaoAluno'
  };

  try {
    const url = baseUrls[endpoint];
    const response = await fetch(url + (params ? `?${new URLSearchParams(params)}` : ''), {
      method: req.method,
      headers: { 'Content-Type': 'application/json', 'Authorization': req.headers.authorization }
    });

    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    res.status(500).json({ error: 'Falha na comunicação com a API' });
  }
}
