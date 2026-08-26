import express, { Application } from 'express';
import path from 'path';
import { adminRoutes } from './routes';
import { authMiddleware } from './middleware';

export function createAdminApp(): Application {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Static files for dashboard
  app.use('/admin/static', express.static(path.join(__dirname, '../admin')));

  // Auth middleware for all /admin/api routes
  app.use('/admin/api', authMiddleware);

  // API routes
  app.use('/admin/api', adminRoutes);

  // Dashboard HTML
  app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
  });

  return app;
}
