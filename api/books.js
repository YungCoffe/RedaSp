export default async function handler(req, res) {
    // 1. Pegar o token
    const token = req.headers.authorization;

    if (!token) {
        return res.status(401).json({ error: 'Token ausente' });
    }

    try {
        // 2. Fazer a requisição para a API oficial
        const response = await fetch('https://prod-apistudent.elefanteletrado.com.br/v1/library/book/readings', {
            method: 'GET',
            headers: {
                'Authorization': token,
                'Content-Type': 'application/json'
            }
        });

        // 3. Obter os dados
        const data = await response.json();
        
        // 4. Retornar os dados
        return res.status(200).json(data);
        
    } catch (error) {
        // Log para debug
        console.error("Erro capturado:", error);
        return res.status(500).json({ error: 'Falha na comunicação com a API externa' });
    }
}
