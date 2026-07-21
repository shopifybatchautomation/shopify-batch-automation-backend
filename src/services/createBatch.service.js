import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';
import { ApiError } from '../utils/api-error.js';
import { CHANNEL_CHECKBOX_IDS, CHANNEL_DISPLAY_NAMES, emitProgress } from './playwrightHelpers.js';
import { launchAndLogin } from './playwrightHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- CONFIRM ORDERS API ----
const CONFIRM_ORDERS_API_URL =
  'https://shopify-oms-ax4n.onrender.com/api/v1/shopify/confirm-orders';
// Resolved relative to this file (not process.cwd()) so the output path is stable across
// however/wherever the script gets launched from - avoids stale files piling up in different dirs.
const ORDER_IDS_OUTPUT_PATH = path.join(__dirname, '..', 'data', 'confirmOrderIds.json');
const REPORTS_DIR = path.join(__dirname, '..', 'reports');

// Fixed (non-timestamped) report paths - each run overwrites these in place instead of piling up
// a new timestamped file every time. REPORTS_DIR is fully cleared at the start of every run
// (see clearReportsDir below), so a category that had failures last run but doesn't this run
// doesn't leave a stale file behind.
const UNMAPPED_PDF_PATH = path.join(REPORTS_DIR, 'unmapped-listing-orders.pdf');
const UNFULFILLED_PDF_PATH = path.join(REPORTS_DIR, 'unfulfilled-orders.pdf');
const UNFULFILLED_CSV_PATH = path.join(REPORTS_DIR, 'unfulfilled-orders.csv');
const CANCELLED_PDF_PATH = path.join(REPORTS_DIR, 'cancelled-orders.pdf');

// One fixed filename per pipeline step (overwritten every run, same convention as the report
// files above) - served statically from app.js at /screenshots/<step>.png. A cache-busting
// `?t=` query param is appended when the URL is handed to the frontend so a stale image from
// the previous run never gets served from the browser cache under the same filename.
const SCREENSHOTS_DIR = path.join(REPORTS_DIR, 'screenshots');

// ---- LATEST BATCH RUN STATE (in-memory) ----
// Holds the stats + generated report file paths from the most recent createBatchService run,
// so the export/stats endpoints (hit later, from a different request) can serve them without
// needing a database. Mutated in place so importers keep a live view via getLatestBatchResult().
const batchState = { latest: null };

const getLatestBatchResult = () => batchState.latest;

// Fetch confirm-orders, strip the leading "#" from each order_id, and dedupe
// (the API returns one entry per line item, so the same order_id repeats for multi-item orders).
async function fetchConfirmOrderIds() {
  const response = await fetch(CONFIRM_ORDERS_API_URL);
  if (!response.ok) {
    throw new Error(`Confirm orders API failed: ${response.status} ${response.statusText}`);
  }
  const json = await response.json();
  const rawIds = (json.data || []).map((order) => order.order_id);
  const uniqueIds = [...new Set(rawIds.map((id) => id.replace(/^#/, '')))];
  return uniqueIds;
}

// fs.writeFile always replaces the full file content (never appends), so every run already
// overwrites the previous data - the generatedAt stamp just makes staleness obvious if a
// downstream consumer ever reads a file that wasn't refreshed.
async function saveOrderIdsToFile(orderIds) {
  await fs.mkdir(path.dirname(ORDER_IDS_OUTPUT_PATH), { recursive: true });
  const payload = { generatedAt: new Date().toISOString(), order_ids: orderIds };
  await fs.writeFile(ORDER_IDS_OUTPUT_PATH, JSON.stringify(payload, null, 2));
  return ORDER_IDS_OUTPUT_PATH;
}

// ---- REPORT HELPERS (PDF / CSV for orders that couldn't be selected) ----
// Wipes every file currently sitting in REPORTS_DIR (not just the 4 known report names) - called
// once at the very start of a batch run so old reports are gone before anything new is generated.
// Only removes files, not sub-directories, and ignores anything that fails to delete rather than
// aborting the whole batch over a stray locked/unreadable file.
async function clearReportsDir() {
  await fs.mkdir(REPORTS_DIR, { recursive: true });
  const entries = await fs.readdir(REPORTS_DIR, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        fs.unlink(path.join(REPORTS_DIR, entry.name)).catch((err) => {
          console.error(`[clearReportsDir] Failed to remove ${entry.name}: ${err.message}`);
        })
      )
  );
}

// Wipes every screenshot left over from the previous run - mirrors clearReportsDir but targets
// SCREENSHOTS_DIR specifically since it's a sub-directory clearReportsDir doesn't reach into.
async function clearScreenshotsDir() {
  await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
  const entries = await fs.readdir(SCREENSHOTS_DIR, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        fs.unlink(path.join(SCREENSHOTS_DIR, entry.name)).catch((err) => {
          console.error(`[clearScreenshotsDir] Failed to remove ${entry.name}: ${err.message}`);
        })
      )
  );
}

// Captures a viewport screenshot of the current page state for a given pipeline step and
// returns its public URL (relative - app.js serves SCREENSHOTS_DIR at /screenshots). Never
// throws - a failed screenshot (e.g. page already closed) shouldn't abort the batch run.
async function captureStepScreenshot(page, step) {
  try {
    const filename = `${step}.png`;
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, filename) });
    return `/screenshots/${filename}?t=${Date.now()}`;
  } catch (err) {
    console.error(`[captureStepScreenshot] Failed for step "${step}": ${err.message}`);
    return null;
  }
}

async function generatePdfReport(filePath, title, lines) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const stream = fsSync.createWriteStream(filePath);
    doc.pipe(stream);

    doc.fontSize(16).text(title, { underline: true });
    doc.moveDown();
    doc
      .fontSize(10)
      .fillColor('gray')
      .text(`Generated: ${new Date().toISOString()}  |  Total: ${lines.length}`);
    doc.moveDown();
    doc.fillColor('black').fontSize(11);

    if (lines.length === 0) {
      doc.text('None');
    } else {
      lines.forEach((line, idx) => doc.text(`${idx + 1}. ${line}`));
    }

    doc.end();
    stream.on('finish', () => resolve(filePath));
    stream.on('error', reject);
  });
}

function toCsv(rows, headers) {
  const escape = (val) => {
    const str = String(val ?? '');
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  }
  return lines.join('\n');
}

async function saveCsv(filePath, rows, headers) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, toCsv(rows, headers));
  return filePath;
}

// Uppercase, 3-letter keys so header text like "JUL 2026" (CSS text-transform: uppercase
// makes innerText() return the visually-rendered caps version, not the raw "Jul") still matches.
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function parseMonthHeader(headerText) {
  const parts = headerText.trim().replace(/\s+/g, ' ').split(' ');
  const monthName = parts[0].toUpperCase().slice(0, 3);
  const year = parseInt(parts[1], 10);
  const month = MONTHS.indexOf(monthName);
  if (month === -1 || Number.isNaN(year)) {
    throw new Error(`Could not parse calendar header: "${headerText}"`);
  }
  return { month, year };
}

// Navigate a single calendar (left/right) to the target month/year using prev/next arrows
async function navigateCalendarTo(calendar, targetMonth, targetYear) {
  const targetIndex = targetYear * 12 + targetMonth;

  for (let i = 0; i < 12; i++) {
    // Use textContent (raw DOM text) so CSS text-transform can't skew parsing
    const headerText = await calendar.locator('.calendar-date th[colspan]').textContent();
    const { month: currentMonth, year: currentYear } = parseMonthHeader(headerText);
    const currentIndex = currentYear * 12 + currentMonth;

    if (currentIndex === targetIndex) return;

    const arrow =
      targetIndex < currentIndex
        ? calendar.locator('th.prev.available')
        : calendar.locator('th.next.available');

    await arrow.click();
    await calendar.page().waitForTimeout(150);
  }
  throw new Error('Calendar navigation exceeded max iterations (12) - check header text format');
}

// Click a specific day number inside a calendar (skips days belonging to prev/next month or disabled)
async function clickDay(calendar, day) {
  const cell = calendar
    .locator('td.available:not(.off):not(.disabled)')
    .filter({ hasText: new RegExp(`^${day}$`) });
  await cell.first().click();
}

// Convert a JS Date to the 12-hour hour/minute/AM-PM values the widget's <select>s expect.
// minuteselect only has 0/15/30/45 options, so round the real minute DOWN to the nearest one.
function get12HourParts(date) {
  let hour = date.getHours();
  const ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12;
  if (hour === 0) hour = 12;

  const minuteOptions = [0, 15, 30, 45];
  const rawMinute = date.getMinutes();
  const minute = [...minuteOptions].reverse().find((m) => m <= rawMinute) ?? 0;

  return { hour, minute, ampm };
}

async function setCalendarTime(calendar, { hour, minute, ampm }) {
  await calendar.locator('.calendar-time .hourselect').selectOption(String(hour));
  await calendar.locator('.calendar-time .minuteselect').selectOption(String(minute));
  await calendar.locator('.calendar-time .ampmselect').selectOption(ampm);
}

// ---- CURSOR/INFINITE-SCROLL PAGINATION ----
// Confirmed from the real order-list markup: uses the jscroll plugin, rows are
// <tr id="InvoiceRowXXXXXX"> inside #infiniteScroll > .jscroll-inner > table#order-table,
// and pagination is driven by window scroll (no separate inner scroll container),
// picking up the next page via the hidden `span.next > a[rel="next"]` link.
const ORDER_ROW_SELECTOR = 'tr[id^="InvoiceRow"]';
const SCROLL_CONTAINER_SELECTOR = null; // page/window scroll — jscroll has no inner scroll div here

async function loadAllOrdersByScrolling(page, { maxScrolls = 100, stableRoundsNeeded = 3 } = {}) {
  const scrollTarget = SCROLL_CONTAINER_SELECTOR
    ? page.locator(SCROLL_CONTAINER_SELECTOR).first()
    : null;

  let previousCount = -1;
  let stableRounds = 0;

  for (let i = 0; i < maxScrolls; i++) {
    const currentCount = await page.locator(ORDER_ROW_SELECTOR).count();

    if (currentCount === previousCount) {
      stableRounds++;
      if (stableRounds >= stableRoundsNeeded) break; // no new rows after several scrolls -> all loaded
    } else {
      stableRounds = 0;
    }
    previousCount = currentCount;

    if (scrollTarget) {
      await scrollTarget.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    } else {
      // jscroll triggers its next-page fetch once the bottom of the page is in view
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    }

    // jscroll shows a "Loading..." spinner in #infiniteScroll while fetching the next page
    await page
      .locator('#infiniteScroll img[alt="Loading"]')
      .waitFor({ state: 'hidden', timeout: 5000 })
      .catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(400);
  }

  return page.locator(ORDER_ROW_SELECTOR).count();
}

// ---- SEARCH LOADED ORDERS BY ID AND CHECK THEM ----
// Assumes each order's rows contain the order_id (with or without the "#") in their visible text,
// and that a checkbox sits somewhere in each row for batch selection. A single order_id can appear
// on MULTIPLE rows (one per line item/SKU), so every matching row is checked, not just the first.
//
// A row can fail to have a checkbox for two known reasons (seen in the real markup):
//   1. Unmapped listing  -> `div.singleLine[title="Unmapped Listing"]` is present in the row
//   2. GST/stock issue   -> checkbox cell replaced by `a.btn-danger`, but NOT unmapped per (1)
//      (the danger button's title text is identical for both cases, so it can't be used alone
//      to distinguish them - the unmapped-listing check must run first)
// Both are tracked separately so reports can be generated for each.
async function selectOrdersByIds(page, orderIds, emit = () => {}) {
  const selected = [];
  const unmappedFailures = []; // orders skipped because of an unmapped listing
  const stockIssueFailures = []; // orders skipped because of a GST/stock issue, with sku code
  // Not present anywhere in the currently-loaded "New Orders" list - in practice this has been
  // confirmed to mean the order got cancelled and moved off this page into the Cancelled tab,
  // but it could also mean it fell outside the date range/warehouse/channel filter.
  const notFoundFailures = [];
  const total = orderIds.length;

  // Emits the live counters the frontend dashboard needs after every order is processed:
  // total confirmed qty, selected-so-far, remaining-to-process, unmapped, and unfulfilled (stock/GST).
  const emitSelectionStats = (processedCount, currentOrderId) => {
    emit('selection-progress', `Processed ${processedCount}/${total} orders`, {
      totalConfirmedOrders: total,
      processedCount,
      currentOrderId,
      selectedCount: selected.length,
      remainingCount: total - processedCount,
      unmappedCount: unmappedFailures.length,
      unfulfilledCount: stockIssueFailures.length,
      cancelledCount: notFoundFailures.length,
    });
  };

  for (let i = 0; i < orderIds.length; i++) {
    const orderId = orderIds[i];
    const rows = page.locator(ORDER_ROW_SELECTOR).filter({ hasText: orderId });
    const rowCount = await rows.count();

    if (rowCount === 0) {
      notFoundFailures.push({ orderId, reason: 'Not found on New Orders page - likely cancelled' });
      emitSelectionStats(i + 1, orderId);
      continue;
    }

    let checkedAny = false;

    for (let j = 0; j < rowCount; j++) {
      const row = rows.nth(j);
      const checkbox = row.locator('input[type="checkbox"]').first();

      if ((await checkbox.count()) > 0) {
        await row.scrollIntoViewIfNeeded();
        const isChecked = await checkbox.isChecked().catch(() => false);
        if (!isChecked) {
          await checkbox.check({ force: true }).catch(() => checkbox.click());
        }
        checkedAny = true;
        continue;
      }

      // No checkbox on this row - figure out why. The red danger button's title text is
      // identical for BOTH unmapped and stock-unavailable rows, so it can't be used to tell
      // them apart. The reliable signal is the product-name cell: `div.singleLine[title="Unmapped
      // Listing"]` (name text itself reads "Unmapped Listing") only appears when the listing is
      // unmapped. If that's absent but the row still has no checkbox, it's a stock/GST issue.
      const isUnmapped =
        (await row.locator('div.singleLine[title="Unmapped Listing"]').count()) > 0;

      if (isUnmapped) {
        unmappedFailures.push({ orderId });
        continue;
      }

      const skuCode = await row
        .locator('a.sku')
        .first()
        .textContent()
        .then((t) => t?.trim())
        .catch(() => '');
      stockIssueFailures.push({ orderId, sku: skuCode || 'N/A' });
    }

    if (checkedAny) {
      selected.push(orderId);
    }

    emitSelectionStats(i + 1, orderId);
  }

  return { selected, unmappedFailures, stockIssueFailures, notFoundFailures };
}

const createBatchService = async (socketId = null) => {
  const emit = (step, message, data = {}) =>
    emitProgress(socketId, step, message, data, 'batch-progress');

  let browser = null;
  let page = null;

  try {
    emit('start', 'Starting batch creation...');

    // Clear out every file left over in REPORTS_DIR from the previous run before doing
    // anything else, so this run starts from a clean slate and only ends up with the
    // report(s) it actually generates
    emit('clearing-reports', 'Clearing old report files...');
    await clearReportsDir();
    await clearScreenshotsDir();

    // Run login/browser launch and the confirm-orders API fetch in parallel - neither depends on the other
    emit('browser-launch', 'Launching browser and fetching confirmed orders...');
    const [loginResult, confirmOrderIds] = await Promise.all([
      launchAndLogin(),
      fetchConfirmOrderIds(),
    ]);
    ({ page, browser } = loginResult);

    const savedPath = await saveOrderIdsToFile(confirmOrderIds);
    console.log(`Saved ${confirmOrderIds.length} order_ids to ${savedPath}`);

    // Let the frontend know the total confirmed orders qty as soon as we know it
    const loginShot = await captureStepScreenshot(page, 'browser-launch');
    emit('total-confirmed', `Found ${confirmOrderIds.length} confirmed orders`, {
      totalConfirmedOrders: confirmOrderIds.length,
      selectedCount: 0,
      remainingCount: confirmOrderIds.length,
      unmappedCount: 0,
      unfulfilledCount: 0,
      cancelledCount: 0,
      screenshotUrl: loginShot,
    });

    // STEP 1 - NAVIGATING TO ORDERS PAGE
    emit('navigate-orders', 'Navigating to orders page...');
    await page.goto(`${process.env.OMS_URL}/orders/newOrders`, { waitUntil: 'networkidle' });
    await page.locator('#forceWarehouseSelector').selectOption('22784');
    await page.waitForLoadState('networkidle');
    const ordersPageShot = await captureStepScreenshot(page, 'navigate-orders');
    emit('navigate-orders', 'Orders page ready', { screenshotUrl: ordersPageShot });

    // STEP 2 - SELECT CHANNEL (SHOPIFY)
    // `[filter-field="channel_company_id"]` alone matches BOTH the clickable column-header link
    // (a.filterColumn) and its popover panel (div#popoverchannel_company_id) - the popover carries
    // the same filter-field attribute, which trips Playwright's strict-mode "resolved to 2
    // elements" error. Scope to the anchor tag so only the trigger link is clicked.
    emit('filter-channel', 'Applying filter for "shopify"...');
    await page.locator('a.filterColumn[filter-field="channel_company_id"]').click();

    const channelPopover = page.locator('#popoverchannel_company_id').first();
    await channelPopover.waitFor({ state: 'visible' });

    const checkbox = channelPopover.locator(`#${CHANNEL_CHECKBOX_IDS['shopify']}`);
    await checkbox.waitFor({ state: 'visible' });
    await checkbox.click();

    const channelSubmitBtn = channelPopover.locator('button.editable-submit');
    await channelSubmitBtn.waitFor({ state: 'visible' });
    await channelSubmitBtn.click();
    const filterShot = await captureStepScreenshot(page, 'filter-channel');
    emit('filter-applied', 'Filter applied for "shopify"', { screenshotUrl: filterShot });

    // STEP 3 - SELECT ORDER DATE RANGE (LAST 10 DAYS -> TODAY)
    // Same strict-mode risk as the channel filter above - scope to the trigger anchor, not any
    // element carrying this filter-field attribute (e.g. its own popover/panel).
    emit('date-range', 'Setting order date range...');
    await page.locator('a.filterColumn[filter-field="order_date"]').click();

    const dateRangePicker = page.locator('.daterangepicker.customTemplate');
    await dateRangePicker.waitFor({ state: 'visible' });

    const today = new Date();
    const fromDate = new Date();
    fromDate.setDate(today.getDate() - 10);

    const leftCalendar = dateRangePicker.locator('.calendar.left');
    const rightCalendar = dateRangePicker.locator('.calendar.right');

    // Select start date (10 days ago) on the left calendar first
    await navigateCalendarTo(leftCalendar, fromDate.getMonth(), fromDate.getFullYear());
    await clickDay(leftCalendar, fromDate.getDate());

    // Then select end date (today) - do this AFTER start date,
    // since disabled/allowed days on the right calendar depend on the chosen start date
    await navigateCalendarTo(rightCalendar, today.getMonth(), today.getFullYear());
    await clickDay(rightCalendar, today.getDate());

    // Set the "To" time to the actual current time (e.g. 10:20 AM) instead of the 12:00 AM default
    await setCalendarTime(rightCalendar, get12HourParts(today));

    // STEP 4 - APPLY
    const applyBtn = dateRangePicker.locator('button.applyBtn');
    await applyBtn.waitFor({ state: 'visible' });
    await applyBtn.click();
    await page.waitForLoadState('networkidle');
    const dateRangeShot = await captureStepScreenshot(page, 'date-range');
    emit('date-range-applied', 'Date range applied', { screenshotUrl: dateRangeShot });

    // STEP 5 - LOAD ALL ORDERS (cursor/infinite-scroll pagination only renders ~100 at a time)
    emit('loading-orders', 'Loading all orders (scrolling)...');
    const loadedOrderCount = await loadAllOrdersByScrolling(page);
    console.log(`Loaded ${loadedOrderCount} orders after scrolling`);
    const loadedShot = await captureStepScreenshot(page, 'loading-orders');
    emit('orders-loaded', `Loaded ${loadedOrderCount} orders`, {
      loadedOrderCount,
      screenshotUrl: loadedShot,
    });

    // STEP 6 - FIND EACH CONFIRM-ORDERS order_id IN THE LOADED LIST AND CHECK IT
    // selectOrdersByIds emits a 'selection-progress' event after every order it processes,
    // carrying the live totalConfirmedOrders / selectedCount / remainingCount / unmappedCount /
    // unfulfilledCount / cancelledCount counters the frontend dashboard needs.
    const { selected, unmappedFailures, stockIssueFailures, notFoundFailures } =
      await selectOrdersByIds(page, confirmOrderIds, emit);
    console.log(`Selected ${selected.length}/${confirmOrderIds.length} orders.`);

    const selectionShot = await captureStepScreenshot(page, 'selection-progress');
    emit('selection-progress', `Selected ${selected.length}/${confirmOrderIds.length} orders`, {
      totalConfirmedOrders: confirmOrderIds.length,
      processedCount: confirmOrderIds.length,
      selectedCount: selected.length,
      remainingCount: 0,
      unmappedCount: unmappedFailures.length,
      unfulfilledCount: stockIssueFailures.length,
      cancelledCount: notFoundFailures.length,
      screenshotUrl: selectionShot,
    });

    // STEP 7 - REPORT ORDERS THAT COULDN'T BE SELECTED
    // Everything lands under REPORTS_DIR = <this file's folder>/../reports (absolute path logged
    // per-file below, and again in the final summary) so the exact save location is always visible.
    emit('generating-reports', 'Generating export reports...');

    // REPORTS_DIR was already cleared at the start of this run (clearReportsDir), so only the
    // categories with failures this time end up writing a file below.
    const generatedFiles = { orderIdsJson: savedPath };

    if (unmappedFailures.length) {
      await generatePdfReport(
        UNMAPPED_PDF_PATH,
        'Unmapped Listing - Orders Not Selected',
        unmappedFailures.map((f) => f.orderId)
      );
      generatedFiles.unmappedListingPdf = UNMAPPED_PDF_PATH;
      console.log(
        `Unmapped listing report (${unmappedFailures.length} orders): ${UNMAPPED_PDF_PATH}`
      );
    }

    if (stockIssueFailures.length) {
      await generatePdfReport(
        UNFULFILLED_PDF_PATH,
        'GST/Stock Issue - Orders Not Selected',
        stockIssueFailures.map((f) => `${f.orderId} - SKU: ${f.sku}`)
      );
      await saveCsv(
        UNFULFILLED_CSV_PATH,
        stockIssueFailures.map((f) => ({ order_id: f.orderId, sku_code: f.sku })),
        ['order_id', 'sku_code']
      );
      // "unfulfilled" (frontend-facing name) = GST/stock issue orders - they couldn't be
      // fulfilled because stock/GST blocked selection.
      generatedFiles.unfulfilledPdf = UNFULFILLED_PDF_PATH;
      generatedFiles.unfulfilledCsv = UNFULFILLED_CSV_PATH;
      console.log(
        `Stock/GST issue report (${stockIssueFailures.length} orders): ${UNFULFILLED_PDF_PATH}, ${UNFULFILLED_CSV_PATH}`
      );
    }

    if (notFoundFailures.length) {
      await generatePdfReport(
        CANCELLED_PDF_PATH,
        'Not Found on New Orders Page (likely Cancelled) - Orders Not Selected',
        notFoundFailures.map((f) => f.orderId)
      );
      generatedFiles.cancelledPdf = CANCELLED_PDF_PATH;
      console.log(
        `Not-found/likely-cancelled report (${notFoundFailures.length} orders): ${CANCELLED_PDF_PATH}`
      );
    }

    // Final confirmation of exactly where everything was written this run
    console.log('--- Files saved this run ---');
    console.log(`order_ids JSON: ${generatedFiles.orderIdsJson}`);
    console.log(
      `Unmapped listing PDF: ${generatedFiles.unmappedListingPdf || '(none - no unmapped orders)'}`
    );
    console.log(
      `Unfulfilled (stock/GST) PDF: ${generatedFiles.unfulfilledPdf || '(none - no stock/GST issue orders)'}`
    );
    console.log(
      `Unfulfilled (stock/GST) CSV: ${generatedFiles.unfulfilledCsv || '(none - no stock/GST issue orders)'}`
    );
    console.log(
      `Cancelled/not-found PDF: ${generatedFiles.cancelledPdf || '(none - all orders were found)'}`
    );
    console.log(`Reports directory: ${REPORTS_DIR}`);

    const stats = {
      totalConfirmedOrders: confirmOrderIds.length,
      selectedCount: selected.length,
      remainingCount: 0,
      unmappedCount: unmappedFailures.length,
      unfulfilledCount: stockIssueFailures.length,
      cancelledCount: notFoundFailures.length,
    };

    const downloadUrls = {
      unmappedPdf: generatedFiles.unmappedListingPdf
        ? '/api/v1/picklist/batch/export/unmapped'
        : null,
      unfulfilledCsv: generatedFiles.unfulfilledCsv
        ? '/api/v1/picklist/batch/export/unfulfilled/csv'
        : null,
      unfulfilledPdf: generatedFiles.unfulfilledPdf
        ? '/api/v1/picklist/batch/export/unfulfilled/pdf'
        : null,
      cancelledPdf: generatedFiles.cancelledPdf ? '/api/v1/picklist/batch/export/cancelled' : null,
    };

    // Persist for the export/stats endpoints to serve, and hand back to the controller for the
    // immediate HTTP response.
    batchState.latest = {
      stats,
      files: generatedFiles,
      downloadUrls,
      generatedAt: new Date().toISOString(),
    };

    const completeShot = await captureStepScreenshot(page, 'complete');
    emit('complete', 'Batch created successfully!', {
      stats,
      downloadUrls,
      screenshotUrl: completeShot,
    });

    return batchState.latest;
  } catch (err) {
    const errorShot = page ? await captureStepScreenshot(page, 'error') : null;
    emit('error', `Batch creation failed: ${err.message}`, {
      error: err.message,
      screenshotUrl: errorShot,
    });
    console.error('[createBatchService] Error:', err);
    if (err instanceof ApiError) throw err;
    throw new ApiError(500, err.message || 'Batch creation failed');
  } finally {
    if (browser) {
      try {
        // await browser.close();
        console.log('All process completed');
      } catch (_) {}
    }
  }
};

export { createBatchService, getLatestBatchResult };
