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
    const dayOfWeek = new Date().getDay(); // 0-6
    
    const operations = [];

    // 1. Основные метрики активности (TTL 30 дней)
    operations.push(
      fetch(`${baseUrl}/setex/app_metrics:last_activity/2592000`, {
        method: 'POST',
        headers,
        body: JSON.stringify(timestamp)
      }),
      fetch(`${baseUrl}/setex/app_metrics:last_ping_date/2592000`, {
        method: 'POST',
        headers,
        body: JSON.stringify(date)
      }),
      fetch(`${baseUrl}/setex/app_metrics:server_status/2592000`, {
        method: 'POST',
        headers,
        body: JSON.stringify("active")
      })
    );

    // 2. Счетчики с TTL
    // Дневной счетчик (TTL 10 дней - чтобы покрыть период отображения)
    operations.push(
      fetch(`${baseUrl}/eval`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          script: `
            local key = KEYS[1]
            local ttl = ARGV[1]
            local current = redis.call('GET', key)
            if current then
              redis.call('INCR', key)
            else
              redis.call('SETEX', key, ttl, 1)
            end
            return redis.call('GET', key)
          `,
          keys: [`daily_pings:${date}`],
          args: ["864000"] // 10 дней
        })
      })
    );

    // Общий счетчик пингов (TTL 30 дней, будет обновляться при каждом пинге)
    operations.push(
      fetch(`${baseUrl}/eval`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          script: `
            local key = KEYS[1]
            local ttl = ARGV[1]
            local current = redis.call('GET', key)
            if current then
              redis.call('INCR', key)
              redis.call('EXPIRE', key, ttl)
            else
              redis.call('SETEX', key, ttl, 1)
            end
            return redis.call('GET', key)
          `,
          keys: ["total_pings"],
          args: ["2592000"] // 30 дней
        })
      })
    );

    // Счетчик по дням недели (TTL 30 дней)
    operations.push(
      fetch(`${baseUrl}/eval`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          script: `
            local key = KEYS[1]
            local ttl = ARGV[1]
            local current = redis.call('GET', key)
            if current then
              redis.call('INCR', key)
              redis.call('EXPIRE', key, ttl)
            else
              redis.call('SETEX', key, ttl, 1)
            end
            return redis.call('GET', key)
          `,
          keys: [`stats:day_${dayOfWeek}`],
          args: ["2592000"] // 30 дней
        })
      })
    );

    // 3. Лог активности с TTL (30 дней)
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

    // 4. Список последних активностей с TTL (7 дней) и автоограничением
    operations.push(
      fetch(`${baseUrl}/eval`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          script: `
            local key = KEYS[1]
            local value = ARGV[1]
            local ttl = ARGV[2]
            
            -- Добавляем новый элемент
            redis.call('LPUSH', key, value)
            
            -- Ограничиваем список до 10 элементов
            redis.call('LTRIM', key, 0, 9)
            
            -- Устанавливаем TTL
            redis.call('EXPIRE', key, ttl)
            
            return redis.call('LRANGE', key, 0, -1)
          `,
          keys: ["recent_activities"],
          args: [timestamp, "604800"] // 7 дней
        })
      })
    );

    // 5. Системная информация с TTL (1 час - обновляется часто)
    const systemInfo = {
      timestamp,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      platform: process.platform,
      version: process.version
    };

    operations.push(
      fetch(`${baseUrl}/setex/system_info/3600`, {
        method: 'POST',
        headers,
        body: JSON.stringify(systemInfo)
      })
    );

    // Выполняем все операции
    const results = await Promise.allSettled(operations);
    
    // Читаем некоторые данные для проверки
    const readOperations = await Promise.allSettled([
      fetch(`${baseUrl}/get/app_metrics:last_activity`, { method: 'POST', headers }),
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