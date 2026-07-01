export default async function handler(req, res) {
    const { type } = req.query;
    const token = req.headers.authorization;

    if (!token) {
        return res.status(401).json({ error: 'Token não fornecido' });
    }

    const url = 'https://prod-apistudent.elefanteletrado.com.br/v1/library/book/readings';

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': token,
                'Origin': 'https://em.elefanteletrado.com.br',
                'Referer': 'https://em.elefanteletrado.com.br/library/panel',
                'Accept': 'application/json, text/plain, */*'
            }
        });

        const data = await response.json();
        return res.status(response.status).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
