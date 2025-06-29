// api/dashboard.js
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

    // Собираем всю статистику параллельно
    const [
      metricsRes,
      totalPingsRes,
      recentActivitiesRes,
      systemInfoRes,
      dbSizeRes,
      maintenanceStatsRes,
      maintenanceLogRes
    ] = await Promise.allSettled([
      fetch(`${baseUrl}/hgetall/app_metrics`, { method: 'POST', headers }),
      fetch(`${baseUrl}/get/total_pings`, { method: 'POST', headers }),
      fetch(`${baseUrl}/lrange/recent_activities/0/-1`, { method: 'POST', headers }),
      fetch(`${baseUrl}/get/system_info`, { method: 'POST', headers }),
      fetch(`${baseUrl}/dbsize`, { method: 'POST', headers }),
      fetch(`${baseUrl}/hgetall/maintenance_stats`, { method: 'POST', headers }),
      fetch(`${baseUrl}/lrange/maintenance_log/0/9`, { method: 'POST', headers })
    ]);

    // Получаем статистику по дням недели
    const dayStatsPromises = [];
    for (let i = 0; i < 7; i++) {
      dayStatsPromises.push(
        fetch(`${baseUrl}/get/stats:day_${i}`, { method: 'POST', headers })
      );
    }
    const dayStatsRes = await Promise.allSettled(dayStatsPromises);

    // Получаем ежедневные пинги за последние 7 дней
    const dailyPingsPromises = [];
    const today = new Date();
    for (let i = 0; i < 7; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      
      dailyPingsPromises.push(
        fetch(`${baseUrl}/get/daily_pings:${dateStr}`, { method: 'POST', headers })
      );
    }
    const dailyPingsRes = await Promise.allSettled(dailyPingsPromises);

    // Парсим результаты
    const parseResponse = async (response) => {
      if (response.status === 'fulfilled' && response.value.ok) {
        try {
          const data = await response.value.json();
          return data.result;
        } catch (e) {
          return null;
        }
      }
      return null;
    };

    const metrics = await parseResponse(metricsRes);
    const totalPings = await parseResponse(totalPingsRes);
    const recentActivities = await parseResponse(recentActivitiesRes);
    const systemInfo = await parseResponse(systemInfoRes);
    const dbSize = await parseResponse(dbSizeRes);
    const maintenanceStats = await parseResponse(maintenanceStatsRes);
    const maintenanceLog = await parseResponse(maintenanceLogRes);

    // Парсим статистику по дням недели
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const weeklyStats = {};
    for (let i = 0; i < 7; i++) {
      const count = await parseResponse(dayStatsRes[i]);
      weeklyStats[dayNames[i]] = parseInt(count) || 0;
    }

    // Парсим ежедневные пинги
    const dailyPings = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const count = await parseResponse(dailyPingsRes[6-i]);
      
      dailyPings.push({
        date: dateStr,
        count: parseInt(count) || 0
      });
    }

    // Парсим системную информацию
    let parsedSystemInfo = null;
    if (systemInfo) {
      try {
        parsedSystemInfo = typeof systemInfo === 'string' ? 
          JSON.parse(systemInfo) : systemInfo;
      } catch (e) {
        parsedSystemInfo = systemInfo;
      }
    }

    // Парсим логи обслуживания
    let parsedMaintenanceLog = [];
    if (maintenanceLog && Array.isArray(maintenanceLog)) {
      parsedMaintenanceLog = maintenanceLog.map(log => {
        try {
          return typeof log === 'string' ? JSON.parse(log) : log;
        } catch (e) {
          return log;
        }
      });
    }

    const dashboard = {
      timestamp: new Date().toISOString(),
      database: {
        size: dbSize,
        connection_status: 'connected'
      },
      activity: {
        total_pings: parseInt(totalPings) || 0,
        last_activity: metrics?.last_activity || null,
        last_ping_date: metrics?.last_ping_date || null,
        server_status: metrics?.server_status || 'unknown'
      },
      recent_activities: recentActivities || [],
      statistics: {
        daily_pings_last_7_days: dailyPings,
        weekly_distribution: weeklyStats,
        total_days_active: dailyPings.filter(d => d.count > 0).length
      },
      maintenance: {
        stats: maintenanceStats || {},
        recent_log: parsedMaintenanceLog
      },
      system: parsedSystemInfo,
      health: {
        database_responsive: dbSize !== null,
        recent_activity_within_24h: metrics?.last_activity ? 
          (Date.now() - new Date(metrics.last_activity).getTime()) < 86400000 : false,
        total_operations_today: dailyPings[dailyPings.length - 1]?.count || 0
      }
    };

    res.status(200).json(dashboard);

  } catch (error) {
    console.error('Dashboard error:', error.message);
    res.status(500).json({ 
      status: 'error', 
      message: 'Failed to load dashboard',
      error: error.message
    });
  }
}