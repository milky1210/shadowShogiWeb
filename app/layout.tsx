import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://shadow-shogi-web.milky9712.chatgpt.site'),
  title: '影将棋 | Shadow Shogi',
  description: '相手の駒の影と動きから正体を読み、隠れた王を探す将棋ゲーム。二人対局と3段階のCPU対局に対応。',
  openGraph: {
    title: '影将棋 | Shadow Shogi',
    description: 'その一手が、正体を語る。二人対局と3段階のCPU対局で遊べる、正体隠匿型の将棋ゲーム。',
    images: [{ url: '/og.png', width: 1672, height: 941, alt: '影将棋 — その一手が、正体を語る。' }],
    locale: 'ja_JP',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: '影将棋 | Shadow Shogi',
    description: 'その一手が、正体を語る。二人対局と3段階のCPU対局で遊べる、正体隠匿型の将棋ゲーム。',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body>{children}</body></html>;
}
