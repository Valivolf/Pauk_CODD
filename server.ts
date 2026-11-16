import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import { startBot } from './bot/main.ts';
import { permissionGuard } from './server/auth.ts';
import { ROOT_DIR, settings } from './server/config.ts';
import { initDb } from './server/db.ts';
import { createBotApiRouter } from './server/routes/botApi.ts';
import { createCalendarRouter } from './server/routes/calendar.ts';
import { createEquipmentRouter } from './server/routes/equipment.ts';
import { createMonitoringAndChatRouter } from './server/routes/monitoringAndChat.ts';
import { createPointsRouter } from './server/routes/points.ts';
import { createReportsRouter } from './server/routes/reports.ts';
import { createStatsAndExtrasRouter } from './server/routes/statsAndExtras.ts';
import { createSystemAndAuthRouter } from './server/routes/systemAndAuth.ts';
import { startBackgroundServices } from './server/services/background.ts';
import { registerViewRoutes } from './server/views.ts';

function startServer(): void {
  initDb();

  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use(cookieParser());
  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: true, limit: '25mb' }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  });

  app.use(
    '/static',
    express.static(path.join(ROOT_DIR, 'static'), {
      maxAge: '1h',
      etag: true,
    }),
  );

  app.use(permissionGuard);

  registerViewRoutes(app);

  app.use(createSystemAndAuthRouter());
  app.use(createCalendarRouter());
  app.use(createPointsRouter());
  app.use(createEquipmentRouter());
  app.use(createReportsRouter());
  app.use(createMonitoringAndChatRouter());
  app.use(createStatsAndExtrasRouter());
  app.use(createBotApiRouter());

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const statusCode =
      typeof (err as { status?: number })?.status === 'number'
        ? (err as { status: number }).status
        : typeof (err as { statusCode?: number })?.statusCode === 'number'
          ? (err as { statusCode: number }).statusCode
          : 500;
    const message = err instanceof Error ? err.message : 'Внутренняя ошибка сервера';
    if (req.path.startsWith('/api/')) {
      res.status(statusCode).json({ detail: message });
      return;
    }
    res.status(statusCode).type('text/plain; charset=utf-8').send(message);
  });

  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`CODD_SPIDER Node.js server listening on http://0.0.0.0:${port}`);
    startBackgroundServices();
    const vkToken = (process.env.VK_TOKEN || '').trim();
    if (process.env.BOT_EMBEDDED !== 'false' && vkToken) {
      startBot({
        vkToken,
        lanCalendarApiUrl: `http://127.0.0.1:${port}`,
        botApiKey: settings.botApiKey,
      });
    } else if (!vkToken) {
      console.log('[bot] VK_TOKEN not set — VK bot polling inactive (API routes /api/bot/* active).');
    }
  });
}

startServer();
