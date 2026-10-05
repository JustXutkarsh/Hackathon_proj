import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'tests', testMatch:'release.browser.spec.js', workers:1,
  use:{baseURL:'http://127.0.0.1:4174', headless:true, channel:process.env.PLAYWRIGHT_CHANNEL || 'chromium'},
  webServer:{command:'node scripts/build.mjs && node scripts/serve.mjs', url:'http://127.0.0.1:4174', reuseExistingServer:false,
    env:{PORT:'4174', BUILD_DIRECTORY:'.browser-build', STATIC_ROOT:'.browser-build', SUPABASE_URL:'https://test.supabase.co', SUPABASE_PUBLISHABLE_KEY:'sb_publishable_browser_test_only', MONAD_TESTNET_ESCROW_ADDRESS:'0x5FbDB2315678afecb367f032d93F642f64180aa3'}},
});
