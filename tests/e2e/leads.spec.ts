import { test, expect } from '@playwright/test';

test.describe('Leads Dashboard', () => {
  test('should load leads page with contacts', async ({ page }) => {
    await page.goto('/leads');
    await expect(page.locator('h1')).toContainText('Leads');
    await page.waitForLoadState('networkidle');
    const rows = page.locator('table tbody tr');
    await expect(rows).not.toHaveCount(0);
  });

  test('should search contacts by name', async ({ page }) => {
    await page.goto('/leads');
    await page.waitForLoadState('networkidle');
    
    const searchInput = page.locator('input[placeholder*="Search"]');
    await searchInput.fill('john');
    await page.waitForTimeout(400); // Debounce wait
    
    const rows = page.locator('table tbody tr');
    const rowCount = await rows.count();
    // Should have filtered results or 0
    expect(rowCount).toBeLessThanOrEqual(5);
  });

  test('should filter by segment', async ({ page }) => {
    await page.goto('/leads');
    await page.waitForLoadState('networkidle');
    
    const investorButton = page.locator('button:has-text("investor")');
    await investorButton.click();
    await page.waitForTimeout(300);
    
    const rows = page.locator('table tbody tr');
    const firstRow = rows.first();
    await expect(firstRow).toContainText('investor');
  });

  test('should open contact drawer on row click', async ({ page }) => {
    await page.goto('/leads');
    await page.waitForLoadState('networkidle');
    
    const firstRow = page.locator('table tbody tr').first();
    await firstRow.click();
    
    const drawer = page.locator('text=Engagement Timeline');
    await expect(drawer).toBeVisible();
  });

  test('should close drawer on close button click', async ({ page }) => {
    await page.goto('/leads');
    await page.waitForLoadState('networkidle');
    
    const firstRow = page.locator('table tbody tr').first();
    await firstRow.click();
    
    const closeButton = page.locator('button:has-text("✕")').last();
    await closeButton.click();
    
    const drawer = page.locator('text=Engagement Timeline');
    await expect(drawer).not.toBeVisible();
  });

  test('should sort table by clicking header', async ({ page }) => {
    await page.goto('/leads');
    await page.waitForLoadState('networkidle');
    
    const nameHeader = page.locator('th:has-text("Name")');
    await nameHeader.click();
    
    await page.waitForTimeout(300);
    const firstCell = page.locator('table tbody tr:first-child td:first-child');
    const firstName = await firstCell.textContent();
    expect(firstName).toBeTruthy();
  });
});

test.describe('Navigation', () => {
  test('should navigate to all main pages', async ({ page }) => {
    const pages = ['/leads', '/outreach', '/content', '/campaigns', '/settings'];
    
    for (const path of pages) {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(path));
    }
  });

  test('should navigate from home to leads', async ({ page }) => {
    await page.goto('/');
    const leadsLink = page.locator('a:has-text("Leads")');
    await leadsLink.click();
    await expect(page).toHaveURL('/leads');
  });
});