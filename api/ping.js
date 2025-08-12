export default function handler(req, res) {
  const apiKeyFromQuery = req.query.key;
  const apiKeyFromHeader = req.headers['x-api-key'];

  console.log('--- Incoming ping ---');
  console.log('Time:', new Date().toISOString());
  console.log('Method:', req.method);
  console.log('From IP:', req.headers['x-forwarded-for'] || req.socket.remoteAddress);
  console.log('User-Agent:', req.headers['user-agent']);
  console.log('Query key:', apiKeyFromQuery);
  console.log('Header key:', apiKeyFromHeader);

  res.status(200).json({
    status: 'ok',
    queryKey: apiKeyFromQuery,
    headerKey: apiKeyFromHeader,
  });
}