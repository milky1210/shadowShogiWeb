# 影将棋 Web

Swift版 `shadowShogi` のWeb移植版です。ローカル二人対局、3段階のCPU対局、Firebaseを使ったオンライン二人対局を遊べます。

本番URLは `https://shadow-shogi.rays-dev.com` を予定しています。静的ファイルはCloudflare Pages、オンライン対局だけFirebase Spark、既存のChatGPT Sites版はバックアップとして残す構成です。

## 構成

- Cloudflare Pages: React/Viteの静的サイト配信。通常アクセスはFirebaseへ接続しません。
- Firebase Authentication: オンライン対局を開いた人だけ匿名ログインします。
- Firebase Realtime Database: 部屋情報と指し手を同期します。
- Cloudflare Web Analytics: トークンを設定した場合だけアクセス解析ビーコンを読み込みます。
- App Check: サイトキーを設定した場合だけ、かつオンライン対局を開いた時だけ初期化します。Spark運用開始時は未設定のままで構いません。

オンライン対局の新規ルームはv3形式です。初期盤面を一度だけ保存し、以後は各指し手だけを追加します。盤面全体を毎回再送する旧形式よりRealtime Databaseの転送量を大きく抑えます。旧v1/v2ルームも読み書きできます。

## ゲームの特徴

- Swift版と同じ制約で初期配置をランダム生成
- 相手の駒は影だけを表示し、駒ごとに予想・あいまい予想を記録
- 予想画面では、その駒が実際に動いた軌跡を5×5の盤で確認
- 成り、持ち駒、駒打ち、二歩、行き所のない駒を判定
- 王を取った時点で勝敗決定（王手・詰み判定なし）
- ローカル二人対局では、一手ごとに端末を相手へ渡すプライバシー画面
- CPUは初級、中級、最強の3段階。CPU対局は通信不要

## 開発と検証

```bash
npm install
npm run dev
```

```bash
npm test
npm run lint
npm run build
npm run test:e2e
```

## 環境変数

`.env.example` を `.env.local` にコピーして使います。Firebaseの公開Web設定はソース内にあり、通常は追加設定なしで動きます。

- `VITE_FIREBASE_APP_ID`: Firebase WebアプリID
- `VITE_FIREBASE_API_KEY`: Firebase関連APIだけに制限したWeb APIキー
- `VITE_FIREBASE_APPCHECK_SITE_KEY`: 任意。reCAPTCHA Enterpriseのサイトキー
- `VITE_PUBLIC_SITE_URL`: `https://shadow-shogi.rays-dev.com`
- `VITE_CLOUDFLARE_WEB_ANALYTICS_TOKEN`: 任意。Cloudflare Web Analyticsのトークン

## デプロイ

Cloudflare Pagesへ静的サイトをデプロイ:

```bash
npm run deploy:cloudflare
```

Cloudflare Pagesプロジェクト名は `shadow-shogi`、出力先は `dist` です。デプロイ後、CloudflareのCustom domainsで `shadow-shogi.rays-dev.com` を接続します。

Firebase Realtime Databaseルールだけをデプロイ:

```bash
npm run deploy:firebase-rules
```

Cloud Functionsの72時間ルーム削除処理は将来Blazeへ切り替えた時用です。Sparkではデプロイしません。

## 緊急停止

Realtime Databaseのデータ画面で次を設定すると、新規ルーム作成・参加・着手を即時停止できます。

```json
{
  "config": {
    "onlineEnabled": false
  }
}
```

再開時は `true` に戻すか、`onlineEnabled` を削除します。セキュリティルール側でも拒否するため、古いブラウザを開いたままの利用者にも効きます。ローカル対局とCPU対局には影響しません。

## 無料枠の監視

- Cloudflare: Web Analyticsで訪問数、ページビュー、参照元、国、端末を確認
- Firebase: Realtime DatabaseのUsageでダウンロード量、ストレージ、同時接続を確認
- Firebase: AuthenticationのUsageで匿名ユーザー増加を確認

まずSparkで公開し、Realtime Databaseの月間ダウンロード量が無料枠10GBの50%に近づいたら毎日確認、80%でオンライン新規受付の停止またはBlaze移行を判断します。静的ページの大量アクセスはCloudflare側で受けるため、Firebase使用量に直結するのは主にオンライン対局利用者です。
