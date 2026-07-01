export default async function handler(req, res) {
    if (req.method !== 'PUT') return res.status(405).end();
    const { taskId, answerId, texto, executedOn } = req.body;
    const token = process.env.X_API_KEY;

    try {
        const response = await fetch(`https://edusp-api.ip.tv/tms/task/${taskId}/answer/${answerId}`, {
            method: 'PUT',
            headers: { 'x-api-key': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                status: "draft",
                answers: { content: texto },
                accessed_on: "room",
                executed_on: executedOn,
                duration: 10.0
            })
        });
        const data = await response.json();
        res.status(200).json(data);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao salvar' });
    }
}
