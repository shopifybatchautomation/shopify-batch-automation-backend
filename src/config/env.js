import 'dotenv/config';

const requiredEnvVars = ['OMS_EMAIL', 'OMS_PASSWORD', 'ALLOWED_ORIGINS', 'OMS_URL'];
for (const v of requiredEnvVars) {
  if (!process.env[v]) {
    console.error(`[Config] Missing required environment variable: ${v}`);
    process.exit(1);
  }
}
