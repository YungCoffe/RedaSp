export default async function handler(req, res) {
    const token = req.headers.authorization;

    if (!token) {
        return res.status(401).json({ error: 'Token de integração ausente' });
    }

    try {
        const response = await fetch('https://prod-apistudent.elefanteletrado.com.br/v1/library/book/readings', {
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            return res.status(response.status).json({ error: 'Erro na API remota: ' + response.status });
        }

        const data = await response.json();
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: 'Erro ao buscar livros: ' + error.message });
    }
}
