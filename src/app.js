import express from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import createBatchRoutes from './routes/createBatch.routes.js';
import { globalErrorHandler } from './middleware/error.middleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Crash handlers ───────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
  process.exit(1);
});

// ─── Allowed origins ──────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim());

const app = express();
const server = http.createServer(app);

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

global.io = io;

io.on('connection', (socket) => {
  console.log('✅ Client connected:', socket.id);
  socket.join(socket.id);

  socket.emit('connected', {
    message: 'Connected to server',
    socketId: socket.id,
  });

  socket.on('disconnect', () => console.log('❌ Client disconnected:', socket.id));
  socket.on('error', (err) => console.error('Socket error:', err));
});

// ─── Middlewares ──────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Make io available in routes
app.use((req, _, next) => {
  req.io = io;
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({
    status: 'ok',
    socketConnections: io.engine.clientsCount,
    timestamp: new Date().toISOString(),
  });
});

app.use('/api/v1/oms', createBatchRoutes);

// Step-by-step Playwright screenshots for the most recent batch run (written by
// createBatch.service.js into src/reports/screenshots)
app.use('/screenshots', express.static(path.join(__dirname, 'reports', 'screenshots')));

// ─── 404 handler ──────────────────────────────────────────────────────────────
app.use('/*path', (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// ─── Error handlers ───────────────────────────────────────────────────────────
app.use(globalErrorHandler);

const PORT = process.env.PORT || 3000;

export { app, server, io, PORT, ALLOWED_ORIGINS };
