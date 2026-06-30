export default async function handler(req, res) {
  // 1. Apenas POST permitido
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
    const { user, senha } = req.body;

    if (!user || !senha) {
      return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
    }

    // 2. Fazendo a requisição para a API real
    const response = await fetch('https://sedintegracoes.educacao.sp.gov.br/saladofuturobffapi/credenciais/api/Login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      },
      body: JSON.stringify({ user, senha })
    });

    const data = await response.json();
    
    // 3. Retorna a resposta da API oficial para o seu front
    return res.status(200).json(data);

  } catch (error) {
    // Se algo quebrar, o erro aparece no log da Vercel
    console.error('Erro no Backend:', error);
    return res.status(500).json({ error: 'Erro interno', details: error.message });
  }
}
