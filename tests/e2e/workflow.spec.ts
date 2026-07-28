import { test, expect } from '@playwright/test';

test.describe('End-to-End Workflow', () => {
  test('should complete full workflow: create lead → send email → schedule post', async ({ page }) => {
    // Step 1: Create a new lead
    await page.goto('/leads');
    await page.locator('button:has-text("Add Lead")').click();
    
    const modalTitle = page.locator('text=Create New Lead');
    await expect(modalTitle).toBeVisible();

    await page.locator('input[placeholder*="name"]').fill('Integration Test User');
    await page.locator('input[placeholder*="email"]').fill('test@example.com');
    await page.locator('input[placeholder*="company"]').fill('Test Corp');
    await page.locator('select').selectOption('investor');
    
    await page.locator('button:has-text("Submit")').click();
    
    const successToast = page.locator('text=Lead created');
    await expect(successToast).toBeVisible({ timeout: 5000 });

    // Step 2: Verify lead appears in table
    await page.reload();
    await page.waitForLoadState('networkidle');
    
    const rows = page.locator('table tbody tr');
    const newLeadRow = rows.filter({ hasText: 'Integration Test User' });
    await expect(newLeadRow).toHaveCount(1);

    // Step 3: Open lead and trigger email
    await newLeadRow.click();
    const drawer = page.locator('text=Engagement Timeline');
    await expect(drawer).toBeVisible();

    // Step 4: Navigate to outreach to send email
    await page.goto('/outreach');
    await page.locator('button:has-text("Generate Email")').click();
    
    // Select the new lead
    await page.locator('button:has-text("Integration Test User")').click();
    
    // Choose template
    await page.locator('button:has-text("Use Template")').first().click();
    
    // Send
    await page.locator('button:has-text("Send Now")').click();
    
    const emailToast = page.locator('text=Email sent');
    await expect(emailToast).toBeVisible({ timeout: 10000 });

    // Step 5: Navigate to content to schedule post
    await page.goto('/content');
    await page.locator('button:has-text("Generate Content")').click();
    
    // Select platforms
    await page.locator('input[type="checkbox"]').first().check();
    
    // Fill content
    await page.locator('textarea').fill('Check out our new product!');
    
    // Generate and schedule
    await page.locator('button:has-text("Generate")').click();
    await page.waitForTimeout(2000);
    
    await page.locator('button:has-text("Schedule")').click();
    
    const contentToast = page.locator('text=Post scheduled');
    await expect(contentToast).toBeVisible({ timeout: 10000 });

    // Step 6: Verify both email and post in respective dashboards
    await page.goto('/outreach');
    const emailRow = page.locator('table tbody tr').filter({ hasText: 'Integration Test User' });
    await expect(emailRow).toHaveCount(1);

    await page.goto('/content');
    const postRow = page.locator('text=Check out our new product');
    await expect(postRow).toBeVisible();
  });
});