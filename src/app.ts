// src/app.ts
import express from 'express';
import { router as inventoryRouter } from './inventory/routes.js';

export function createApp() {
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/inventory', inventoryRouter);
  return app;
}
