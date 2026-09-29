// src/app.ts
import express from 'express';
import { router as inventoryRouter } from './inventory/routes.js';
import { locationsRouter, productsRouter } from './masterdata/routes.js';

export function createApp() {
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/inventory', inventoryRouter);
  app.use('/products', productsRouter);
  app.use('/locations', locationsRouter);
  return app;
}
