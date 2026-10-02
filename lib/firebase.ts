import { initializeApp } from 'firebase/app';
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from 'firebase/app-check';
import { getAuth } from 'firebase/auth';
import { getDatabase } from 'firebase/database';

const firebaseApiKey = import.meta.env?.VITE_FIREBASE_API_KEY;

export function assertFirebaseConfigured() {
  if (!firebaseApiKey) {
    throw new Error(
      'オンライン対局のFirebase設定が不足しています。管理者へ連絡してください。',
    );
  }
}

const firebaseConfig = {
  apiKey: firebaseApiKey || 'missing-firebase-api-key',
  authDomain: 'shadowshogi.firebaseapp.com',
  databaseURL:
    'https://shadowshogi-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'shadowshogi',
  appId:
    import.meta.env?.VITE_FIREBASE_APP_ID ||
    '1:952362413025:web:a81c7e717fb452a326c0a0',
};

export const firebaseApp = initializeApp(firebaseConfig);

// This module is dynamically imported only when online play is opened. Keeping
// App Check here prevents local and CPU-only visits from consuming assessments.
const appCheckSiteKey = import.meta.env?.VITE_FIREBASE_APPCHECK_SITE_KEY;
if (appCheckSiteKey && firebaseConfig.appId) {
  initializeAppCheck(firebaseApp, {
    provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
    isTokenAutoRefreshEnabled: true,
  });
}

export const firebaseAuth = getAuth(firebaseApp);
export const firebaseDatabase = getDatabase(firebaseApp);
