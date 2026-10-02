import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { GameApp } from '@/components/game-app';
import '@/app/globals.css';

const cloudflareAnalyticsToken = import.meta.env
  .VITE_CLOUDFLARE_WEB_ANALYTICS_TOKEN;
if (cloudflareAnalyticsToken) {
  const beacon = document.createElement('script');
  beacon.defer = true;
  beacon.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  beacon.dataset.cfBeacon = JSON.stringify({
    token: cloudflareAnalyticsToken,
  });
  document.head.append(beacon);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GameApp />
  </StrictMode>,
);
