import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'tests', testMatch:'browser.spec.js', workers:1,
  use:{baseURL:'http://127.0.0.1:4174', headless:true, channel:process.env.PLAYWRIGHT_CHANNEL || 'chromium'},
  webServer:{command:'node scripts/build.mjs && node scripts/serve.mjs', url:'http://127.0.0.1:4174', reuseExistingServer:false,
    env:{PORT:'4174', SUPABASE_URL:'https://test.supabase.co', SUPABASE_PUBLISHABLE_KEY:'sb_publishable_browser_test_only'}},
});
