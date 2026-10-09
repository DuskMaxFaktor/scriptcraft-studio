import { defineConfig } from '@playwright/test';
import fs from 'fs';

// Smoke test of an already running installed studio (see scripts/clean_pc_check.ps1).
const channel = [
  ['chrome', `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`],
  ['chrome', `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`],
  ['msedge', `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`],
  ['msedge', `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`],
].find(([, exe]) => process.platform === 'win32' && fs.existsSync(exe))?.[0];

export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: 'list',
  use: { baseURL: process.env.SMOKE_URL || 'http://127.0.0.1:3456', channel, headless: true, locale: 'ru-RU', viewport: { width: 1440, height: 900 } },
});
