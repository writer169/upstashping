export default async function handler(req, res) {
  // Проверяем API ключ
  const apiKey = req.headers['x-api-key'] || req.query.key;
  
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const baseUrl = `https://${process.env.UPSTASH_REDIS_ENDPOINT}`;
    const headers = {
      'Authorization': `Bearer ${process.env.UPSTASH_REDIS_TOKEN}`,
      'Content-Type': 'application/json'
    };

    const timestamp = new Date().toISOString();
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    
    // Выполняем различные операции для активности
    const operations = [];

    // 1. Записываем метрики активности
    operations.push(
      fetch(`${baseUrl}/hset/app_metrics`, {
        method: 'POST',
        headers,
        body: JSON.stringify([
          "last_activity", timestamp,
          "last_ping_date", date,
          "server_status", "active"
        ])
      })
    );

    // 2. Инкрементируем счетчики
    operations.push(
      fetch(`${baseUrl}/incr/daily_pings:${date}`, {
        method: 'POST',
        headers
      })
    );

    operations.push(
      fetch(`${baseUrl}/incr/total_pings`, {
        method: 'POST',
        headers
      })
    );

    // 3. Записываем лог активности с TTL (автоудаление через 30 дней)
    operations.push(
      fetch(`${baseUrl}/setex/activity_log:${timestamp}/2592000`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          timestamp,
          type: "keepalive",
          source: "cron",
          status: "success"
        })
      })
    );

    // 4. Обновляем список последних активностей (сохраняем только последние 10)
    operations.push(
      fetch(`${baseUrl}/lpush/recent_activities`, {
        method: 'POST',
        headers,
        body: JSON.stringify(timestamp)
      }),
      fetch(`${baseUrl}/ltrim/recent_activities/0/9`, {
        method: 'POST',
        headers
      })
    );

    // 5. Записываем статистику по дням недели
    const dayOfWeek = new Date().getDay();
    operations.push(
      fetch(`${baseUrl}/incr/stats:day_${dayOfWeek}`, {
        method: 'POST',
        headers
      })
    );

    // 6. Сохраняем системную информацию
    const systemInfo = {
      timestamp,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      platform: process.platform,
      version: process.version
    };

    operations.push(
      fetch(`${baseUrl}/set/system_info`, {
        method: 'POST',
        headers,
        body: JSON.stringify(systemInfo)
      })
    );

    // Выполняем все операции
    const results = await Promise.allSettled(operations);
    
    // Читаем некоторые данные для дополнительной активности
    const readOperations = await Promise.allSettled([
      fetch(`${baseUrl}/hgetall/app_metrics`, { method: 'POST', headers }),
      fetch(`${baseUrl}/get/total_pings`, { method: 'POST', headers }),
      fetch(`${baseUrl}/lrange/recent_activities/0/4`, { method: 'POST', headers })
    ]);

    const successfulWrites = results.filter(r => r.status === 'fulfilled').length;
    const successfulReads = readOperations.filter(r => r.status === 'fulfilled').length;

    console.log(`Redis activity completed: ${successfulWrites} writes, ${successfulReads} reads`);
    
    res.status(200).json({ 
      status: 'success', 
      message: 'Database activity completed successfully',
      timestamp,
      operations: {
        writes_completed: successfulWrites,
        reads_completed: successfulReads,
        total_operations: results.length + readOperations.length
      }
    });

  } catch (error) {
    console.error('Database activity error:', error.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Database activity failed',
      error: error.message
    });
  }
}