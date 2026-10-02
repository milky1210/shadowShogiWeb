import { expect, test, type Page } from '@playwright/test';

async function startLocalMatch(page: Page) {
  await page.goto('/');
  await expect(page.locator('main[data-app-ready="true"]')).toBeVisible();
  await page.getByRole('button', { name: /二人対局 ローカル/ }).click();
  await page.getByRole('button', { name: /この対局を開始/ }).click();
  await expect(page.locator('.board-grid')).toBeVisible();
  await page.evaluate(() => {
    const state = window as typeof window & { __lastBoardClick?: string };
    state.__lastBoardClick = '';
    document.addEventListener(
      'click',
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        state.__lastBoardClick =
          target.closest<HTMLElement>('.board-square')?.dataset.displayCell ?? '';
      },
      { capture: true },
    );
  });
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`右端9マスの端までクリックできる (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await startLocalMatch(page);
    const rightColumn = page.locator('.board-square:nth-child(9n)');
    await expect(rightColumn).toHaveCount(9);

    for (let row = 0; row < 9; row += 1) {
      const square = rightColumn.nth(row);
      await square.scrollIntoViewIfNeeded();
      const box = await square.boundingBox();
      expect(box).not.toBeNull();
      const point = {
        x: box!.x + box!.width - 2,
        y: box!.y + box!.height / 2,
      };
      const cell = `${row}-8`;

      const hitInfo = await page.evaluate(({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        return {
          cell:
            hit?.closest<HTMLElement>('.board-square')?.dataset.displayCell ?? '',
          hit: hit instanceof HTMLElement ? `${hit.tagName}.${hit.className}` : '',
          innerHeight: window.innerHeight,
          scrollY: window.scrollY,
          x,
          y,
        };
      }, point);
      expect(hitInfo.cell, JSON.stringify(hitInfo)).toBe(cell);

      await page.evaluate(() => {
        (window as typeof window & { __lastBoardClick?: string }).__lastBoardClick = '';
      });
      await page.mouse.click(point.x, point.y);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as typeof window & { __lastBoardClick?: string })
                .__lastBoardClick ?? '',
          ),
        )
        .toBe(cell);

      const backButton = page.getByRole('button', { name: '戻る' });
      if (await backButton.isVisible()) {
        await backButton.click();
        await expect(backButton).toBeHidden();
      } else if (await square.evaluate((element) => element.classList.contains('selected-square'))) {
        await page.mouse.click(point.x, point.y);
        await expect(square).not.toHaveClass(/selected-square/);
      }
    }
  });
}

for (const sideCase of [
  { random: 0.1, expected: '後手・あなた' },
  { random: 0.9, expected: '先手・あなた' },
]) {
  test(`CPU対局の先後抽選: ${sideCase.expected}`, async ({ page }) => {
    await page.addInitScript((randomValue) => {
      Math.random = () => randomValue;
    }, sideCase.random);
    await page.goto('/');
    await expect(page.locator('main[data-app-ready="true"]')).toBeVisible();
    await page.getByRole('button', { name: /vs あゆむくん/ }).click();
    await page.getByRole('button', { name: /この対局を開始/ }).click();
    await expect(page.getByText(sideCase.expected, { exact: true })).toBeVisible();
  });
}

test('CPUの手番中も相手の影を予想でき、自分の駒は動かせない', async ({ page }) => {
  await page.addInitScript(() => {
    Math.random = () => 0.1;
    class IdleWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      postMessage() {}
      terminate() {}
    }
    Object.defineProperty(window, 'Worker', { value: IdleWorker });
  });
  await page.goto('/');
  await expect(page.locator('main[data-app-ready="true"]')).toBeVisible();
  await page.getByRole('button', { name: /vs あゆむくん/ }).click();
  await page.getByRole('button', { name: /この対局を開始/ }).click();
  await expect(page.locator('main[data-phase="cpu-thinking"]')).toBeVisible();

  const ownSquare = page.locator('.board-square:has(.own-piece)').first();
  await ownSquare.click();
  await expect(ownSquare).not.toHaveClass(/selected-square/);

  await page.locator('.board-square:has(.enemy-piece)').first().click();
  await expect(
    page.getByRole('heading', { name: 'この影の正体を予想' }),
  ).toBeVisible();
});

test('スマホでは駒台まで初期表示し、行動ログをその下へ置く', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Math.random = () => 0.9;
  });
  await page.goto('/');
  await expect(page.locator('main[data-app-ready="true"]')).toBeVisible();
  await page.getByRole('button', { name: /vs 金一/ }).click();
  await page.getByRole('button', { name: /この対局を開始/ }).click();

  const mobileLog = page.locator('.mobile-activity-log');
  await expect(mobileLog).toBeVisible();
  await expect(page.locator('.control-activity-log')).toBeHidden();

  const layout = await page.evaluate(() => {
    const rect = (selector: string) => {
      const { top, bottom } =
        document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      return { top, bottom };
    };
    return {
      opponent: rect('.opponent-zone'),
      board: rect('.board-frame'),
      own: rect('.own-zone'),
      log: rect('.mobile-activity-log'),
      viewportHeight: window.innerHeight,
      scrollY: window.scrollY,
    };
  });
  expect(layout.opponent.top).toBeLessThan(layout.board.top);
  expect(layout.board.bottom).toBeLessThan(layout.own.top);
  expect(layout.own.bottom).toBeLessThan(layout.log.top);
  expect(layout.own.bottom).toBeLessThanOrEqual(layout.viewportHeight);
  expect(layout.scrollY).toBe(0);
});

test('CPU対局では相手欄に選択したキャラクターアイコンを表示する', async ({ page }) => {
  await page.addInitScript(() => {
    Math.random = () => 0.9;
  });
  await page.goto('/');
  await expect(page.locator('main[data-app-ready="true"]')).toBeVisible();
  await page.getByRole('button', { name: /vs 金一/ }).click();
  await page.getByRole('button', { name: /この対局を開始/ }).click();

  await expect(page.locator('.opponent-zone .opponent-cpu-avatar.portrait-2')).toBeVisible();
  await expect(page.locator('.opponent-zone .mini-piece')).toHaveCount(0);
});

test('PCのCPUメインビジュアルには横長専用画像を使う', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(page.locator('main[data-app-ready="true"]')).toBeVisible();
  await page.getByRole('button', { name: /vs かげむしゃ王/ }).click();

  const hero = page.locator('.home-character.portrait-3');
  await expect(hero).toBeVisible();
  await expect
    .poll(() => hero.evaluate((element) => getComputedStyle(element).backgroundImage))
    .toContain('hero-kagemusha-oh.webp');
});
