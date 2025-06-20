export default async function handler(req, res) {
  // Проверяем API ключ
  const apiKey = req.headers['x-api-key'] || req.query.key;
  
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Подключаемся к Upstash Redis
    const response = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/ping`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.ok) {
      console.log('Redis ping successful');
      res.status(200).json({ 
        status: 'success', 
        message: 'Redis pinged successfully',
        timestamp: new Date().toISOString()
      });
    } else {
      console.error('Redis ping failed:', response.status);
      res.status(500).json({ 
        status: 'error', 
        message: 'Redis ping failed' 
      });
    }
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Internal server error' 
    });
  }
}
