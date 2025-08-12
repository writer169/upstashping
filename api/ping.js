export default async function handler(req, res) {
  // Проверка API-ключа
  const apiKey = req.headers['x-api-key'] || req.query.key;
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const baseUrl = `https://${process.env.UPSTASH_REDIS_ENDPOINT}`;
  const headers = {
    'Authorization': `Bearer ${process.env.UPSTASH_REDIS_TOKEN}`,
    'Content-Type': 'application/json'
  };

  const timestamp = new Date().toISOString();
  const date = timestamp.split('T')[0]; // YYYY-MM-DD
  const dayOfWeek = new Date().getDay(); // 0-6

  try {
    const operations = [];

    // 1. Метрики активности
    operations.push(
      fetch(`${baseUrl}/setex/app_metrics:last_activity/2592000`, { method: 'POST', headers, body: JSON.stringify(timestamp) }),
      fetch(`${baseUrl}/setex/app_metrics:last_ping_date/2592000`, { method: 'POST', headers, body: JSON.stringify(date) }),
      fetch(`${baseUrl}/setex/app_metrics:server_status/2592000`, { method: 'POST', headers, body: JSON.stringify("active") })
    );

    // 2. Дневной счетчик
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
          args: ["864000"]
        })
      })
    );

    // 3. Общий счетчик пингов
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
          args: ["2592000"]
        })
      })
    );

    // 4. Счетчик по дням недели
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
          args: ["2592000"]
        })
      })
    );

    // 5. Лог активности
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

    // 6. Список последних активностей
    operations.push(
      fetch(`${baseUrl}/eval`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          script: `
            local key = KEYS[1]
            local value = ARGV[1]
            local ttl = ARGV[2]
            redis.call('LPUSH', key, value)
            redis.call('LTRIM', key, 0, 9)
            redis.call('EXPIRE', key, ttl)
            return redis.call('LRANGE', key, 0, -1)
          `,
          keys: ["recent_activities"],
          args: [timestamp, "604800"]
        })
      })
    );

    // 7. Системная информация
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

    // Выполнение всех операций
    const results = await Promise.allSettled(operations);

    // Чтение данных
    const readOps = await Promise.allSettled([
      fetch(`${baseUrl}/get/app_metrics:last_activity`, { method: 'POST', headers }),
      fetch(`${baseUrl}/get/total_pings`, { method: 'POST', headers }),
      fetch(`${baseUrl}/lrange/recent_activities/0/4`, { method: 'POST', headers })
    ]);

    // Формируем отчёт
    const summary = {
      writes: results.map((r, i) => ({
        index: i,
        status: r.status,
        error: r.status === 'rejected' ? r.reason.message : null
      })),
      reads: readOps.map((r, i) => ({
        index: i,
        status: r.status,
        error: r.status === 'rejected' ? r.reason.message : null
      }))
    };

    // Лог в консоль
    console.log('Ping summary:', JSON.stringify(summary, null, 2));

    res.status(200).json({
      status: 'success',
      timestamp,
      summary
    });

  } catch (error) {
    // Логируем неожиданные ошибки
    console.error('Unexpected error in ping handler:', error);
    res.status(200).json({
      status: 'error',
      message: error.message
    });
  }
}