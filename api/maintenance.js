// api/maintenance.js
export default async function handler(req, res) {
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
    const operations = [];

    // 1. Очищаем старые ежедневные счетчики (старше 7 дней)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    for (let i = 0; i < 7; i++) {
      const oldDate = new Date(sevenDaysAgo);
      oldDate.setDate(oldDate.getDate() - i);
      const dateStr = oldDate.toISOString().split('T')[0];
      
      operations.push(
        fetch(`${baseUrl}/del/daily_pings:${dateStr}`, {
          method: 'POST',
          headers
        })
      );
    }

    // 2. Обновляем статистику обслуживания
    operations.push(
      fetch(`${baseUrl}/hset/maintenance_stats`, {
        method: 'POST',
        headers,
        body: JSON.stringify([
          "last_maintenance", timestamp,
          "maintenance_count", "1"  // будет инкрементироваться
        ])
      })
    );

    operations.push(
      fetch(`${baseUrl}/hincrby/maintenance_stats/maintenance_count/1`, {
        method: 'POST',
        headers
      })
    );

    // 3. Создаем резервную копию важных данных
    const backupData = {
      timestamp,
      type: "maintenance_backup",
      created_by: "cron_maintenance"
    };

    operations.push(
      fetch(`${baseUrl}/setex/backup:${timestamp}/604800`, { // TTL 7 дней
        method: 'POST',
        headers,
        body: JSON.stringify(backupData)
      })
    );

    // 4. Проверяем размер базы данных
    operations.push(
      fetch(`${baseUrl}/dbsize`, {
        method: 'POST',
        headers
      })
    );

    // 5. Записываем лог обслуживания
    operations.push(
      fetch(`${baseUrl}/lpush/maintenance_log`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          timestamp,
          action: "routine_maintenance",
          operations_count: operations.length
        })
      }),
      // Оставляем только последние 20 записей
      fetch(`${baseUrl}/ltrim/maintenance_log/0/19`, {
        method: 'POST',
        headers
      })
    );

    // Выполняем все операции
    const results = await Promise.allSettled(operations);
    const successful = results.filter(r => r.status === 'fulfilled').length;

    // Читаем статистику после обслуживания
    const statsResponse = await fetch(`${baseUrl}/hgetall/maintenance_stats`, {
      method: 'POST',
      headers
    });

    const dbSizeResponse = await fetch(`${baseUrl}/dbsize`, {
      method: 'POST',
      headers
    });

    let stats = null;
    let dbSize = null;

    try {
      stats = await statsResponse.json();
      dbSize = await dbSizeResponse.json();
    } catch (e) {
      console.log('Could not parse maintenance stats');
    }

    console.log(`Database maintenance completed: ${successful}/${operations.length} operations`);
    
    res.status(200).json({ 
      status: 'success', 
      message: 'Database maintenance completed',
      timestamp,
      operations: {
        total: operations.length,
        successful,
        failed: operations.length - successful
      },
      stats: stats?.result || null,
      database_size: dbSize?.result || null
    });

  } catch (error) {
    console.error('Maintenance error:', error.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Maintenance failed',
      error: error.message
    });
  }
}