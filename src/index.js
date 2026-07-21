import './config/env.js';
import { server, PORT, ALLOWED_ORIGINS } from './app.js';

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔌 WebSocket server ready`);
  console.log(`✅ Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
