// src/services/picklist/playwrightHelpers.js
import { chromium } from 'playwright';
import { ApiError } from '../utils/api-error.js';
import fs from 'fs';

// ─── Helper: Progress emit ───────────────────────────────────────────────────
export const emitProgress = (socketId, step, message, data = {}, event = 'picklist-progress') => {
  if (socketId && global.io) {
    global.io.to(socketId).emit(event, {
      step,
      message,
      data,
      timestamp: new Date().toISOString(),
    });
    console.log(`[Progress] ${socketId} → ${step}: ${message}`);
  }
};

// ─── Helper: Launch browser and login ───────────────────────────────────────
// Headless by default (required in Docker/production - no display server there).
// Set PLAYWRIGHT_HEADLESS=false in your local .env to watch the browser while debugging
// on a machine that has a real display; leave it unset (or true) everywhere else.
const HEADLESS = process.env.PLAYWRIGHT_HEADLESS !== 'false';

export const launchAndLogin = async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser
    .newContext({ timezoneId: 'Asia/Kolkata' })
    .then((ctx) => ctx.newPage());
  page.setDefaultTimeout(60_000);

  await page.goto(process.env.OMS_URL, { waitUntil: 'networkidle' });
  await page.getByPlaceholder('Email Address').fill(process.env.OMS_EMAIL);
  await page.getByPlaceholder('Password').fill(process.env.OMS_PASSWORD);
  await page.getByRole('button', { name: 'Login' }).click();
  await page.waitForLoadState('networkidle');

  return { browser, page };
};

// ─── Helper: Bell notification poller with retry ────────────────────────────
export const clickBellAndWaitForNotification = async (page, titleText, maxRetries = 10) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[Bell] Attempt ${attempt}/${maxRetries} — looking for: "${titleText}"`);

    try {
      await page.reload({ waitUntil: 'networkidle' });

      await page.locator('i.fa-bell').click();
      await page.waitForSelector('#ClientNotificationsList li.item', {
        timeout: 8000,
        state: 'visible',
      });

      const link = page.locator(`#ClientNotificationsList li.item a[title="${titleText}"]`).first();

      if ((await link.count()) > 0) {
        console.log(`[Bell] Notification found on attempt ${attempt}`);
        return link;
      }

      console.log(`[Bell] Notification not ready yet — retrying...`);
    } catch (err) {
      console.log(`[Bell] Attempt ${attempt} error: ${err.message}`);
    }

    try {
      await page.keyboard.press('Escape');
    } catch (_) {}

    const waitMs = 5000 + attempt * 2000;
    console.log(`[Bell] Waiting ${waitMs}ms before next attempt...`);
    await page.waitForTimeout(waitMs);
  }

  throw new ApiError(500, `Notification not found after ${maxRetries} attempts: "${titleText}"`);
};

// ─── Helper: Safe file rename ────────────────────────────────────────────────
export const safeRename = (src, dest) => {
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  fs.renameSync(src, dest);
};

// ── Constants ──────────────────────────────────────────────────────────────
export const CHANNEL_CHECKBOX_IDS = {
  ajio: 'checkbox46180',
  myntra: 'checkbox46241',
  nykaa: 'checkbox47950',
  shopify: 'checkbox46242',
  tatacliq: 'checkbox46240',
  allchannel: 'filterOptionsSelectAll_channel_company_id',
};

export const CHANNEL_DISPLAY_NAMES = {
  myntra: 'Qurvii - Myntra PPMP',
  nykaa: 'Qurvii - Nykaa Fashion',
  ajio: 'Qurvii - Ajio Dropship',
  tatacliq: 'Qurvii - Tatacliq',
};
