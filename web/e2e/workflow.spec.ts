import { test, expect } from '@playwright/test';

test('storage shows S3 versions, the soft budget, disk capacity and lookup failures on mobile', async ({
  page,
}) => {
  let unavailable = false;
  await page.route('**/v1/storage/usage', (route) =>
    route.fulfill({
      json: {
        driver: 's3',
        s3: unavailable
          ? {
              status: 'error',
              bucket: 'grt-research-test',
              prefix: 'grt/',
              checked_at: new Date().toISOString(),
              message: 'S3 사용량을 조회하지 못했습니다.',
            }
          : {
              status: 'ok',
              bucket: 'grt-research-test',
              prefix: 'grt/',
              budget_bytes: 1000000000000,
              used_bytes: 1100000000000,
              current_bytes: 1000000000000,
              noncurrent_bytes: 100000000000,
              object_count: 12,
              version_count: 14,
              checked_at: new Date().toISOString(),
            },
        disk: {
          filesystems: [
            {
              paths: ['/home/ec2-user/GRT_server', '/tmp'],
              total_bytes: 20000000000,
              used_bytes: 5000000000,
              available_bytes: 14000000000,
            },
          ],
          errors: [],
          checked_at: new Date().toISOString(),
        },
      },
    }),
  );
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');
  await page.getByLabel('계정', { exact: true }).fill('owner');
  await page.getByLabel('비밀번호', { exact: true }).fill('browser-test-password-123');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await page.getByRole('button', { name: '설정', exact: true }).click();
  const storage = page.getByRole('region', { name: '저장공간', exact: true });
  await expect(page.getByRole('region', { name: '월별 다운로드', exact: true })).toHaveCount(0);
  await expect(storage).toContainText('1.10 TB');
  await expect(storage).toContainText('이전 버전 100.00 GB');
  await expect(storage).toContainText('관리 기준에 도달');
  await expect(storage).toContainText('여유 공간 14.00 GB');
  await expect(storage.getByRole('meter', { name: 'S3 사용량', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  unavailable = true;
  await storage.getByRole('button', { name: '저장공간 새로고침' }).click();
  await expect(storage.getByRole('alert')).toContainText('조회하지 못했습니다');
  await expect(storage.getByRole('meter', { name: 'S3 사용량', exact: true })).toHaveCount(0);
  await expect(storage.getByRole('meter', { name: '디스크 사용량', exact: true })).toBeVisible();
});

test('owner registers a schema and a queued experiment; read-only session cannot mutate', async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (e) => browserErrors.push(e.message));
  await page.goto('/');
  await page.getByLabel('계정', { exact: true }).fill('owner');
  await page.getByLabel('비밀번호', { exact: true }).fill('browser-test-password-123');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.getByRole('heading', { name: '실험', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '큐·실행기', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept('research'));
  await page.getByRole('button', { name: '+ 큐 만들기' }).click();
  await expect(page.getByRole('heading', { name: 'research active' })).toBeVisible();
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await expect(page.getByRole('region', { name: '저장공간', exact: true })).toBeVisible();
  await expect(page.getByRole('meter', { name: '디스크 사용량' }).first()).toBeVisible();
  await expect(page.getByText('S3가 연결되지 않았습니다.')).toBeVisible();
  await expect(page.getByLabel('Checkpoint 보관 일수')).toHaveCount(0);
  await expect(page.getByLabel('결과 보관 일수')).toHaveCount(0);
  await page.getByLabel('최대 실행 시간 (초)').fill('7200');
  await page.getByLabel('전송 여유 (초)').fill('60');
  const [policy] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/v1/settings') && response.request().method() === 'PATCH',
    ),
    page.getByRole('button', { name: '정책 저장', exact: true }).click(),
  ]);
  expect(policy.status()).toBe(200);
  expect(await policy.json()).toMatchObject({
    max_attempt_seconds: 7200,
    upload_margin_seconds: 60,
  });
  await page.getByRole('button', { name: '새 불변 schema 등록' }).click();
  await expect(page.getByText('등록된 schema (1)')).toBeVisible();
  await page.getByRole('button', { name: '실험', exact: true }).click();
  await page.getByRole('button', { name: '+ 신규 실험' }).click();
  await page.getByRole('button', { name: '서버 검증', exact: true }).click();
  await expect(page.getByRole('button', { name: '검증한 실험 등록' })).toBeEnabled();
  await page.getByRole('button', { name: '검증한 실험 등록' }).click();
  await expect(page.getByRole('button', { name: '첫 실험', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '첫 실험', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '실험 상세' })).toBeVisible();
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByRole('button', { name: '수정', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '실험 수정' });
  await edit.getByLabel('실험 이름', { exact: true }).fill('관리 실험');
  await edit.getByLabel('Campaign', { exact: true }).fill('browser-campaign');
  await edit.getByLabel('우선순위', { exact: true }).fill('7');
  await edit
    .getByLabel('W&B 링크', { exact: true })
    .fill('https://wandb.ai/grt/research/runs/browser');
  const [update] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/v1/jobs/') && r.request().method() === 'PATCH'),
    edit.getByRole('button', { name: '저장', exact: true }).click(),
  ]);
  expect(update.status()).toBe(200);
  expect(await update.json()).toMatchObject({
    name: '관리 실험',
    labels: { campaign: 'browser-campaign' },
    priority: 7,
  });
  await expect(edit).not.toBeVisible();
  await expect(page.getByRole('link', { name: 'W&B 열기 ↗', exact: true })).toHaveAttribute(
    'href',
    'https://wandb.ai/grt/research/runs/browser',
  );
  await expect(page.getByRole('button', { name: '관리 실험', exact: true })).toBeVisible();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const editButton = page.getByRole('button', { name: '수정', exact: true });
    expect((await editButton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await editButton.click();
    const mobileDialog = page.getByRole('dialog', { name: '실험 수정' });
    await expect(mobileDialog).toBeVisible();
    const box = (await mobileDialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(
      await mobileDialog
        .getByLabel('실험 이름', { exact: true })
        .evaluate((e) => getComputedStyle(e).fontSize),
    ).toBe('16px');
    await page.keyboard.press('Escape');
    await expect(mobileDialog).not.toBeVisible();
    await page.getByRole('button', { name: '큐·실행기', exact: true }).click();
    await expect(page.getByRole('button', { name: '큐 삭제', exact: true })).toBeDisabled();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByRole('button', { name: '설정', exact: true }).click();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByRole('button', { name: '실험', exact: true }).click();
  }
  await page.screenshot({ path: '/tmp/grt-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await expect(page.getByRole('button', { name: '이어서 학습', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '큐·실행기', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept('followup'));
  await page.getByRole('button', { name: '+ 큐 만들기' }).click();
  await expect(page.getByRole('heading', { name: 'followup active', exact: true })).toBeVisible();
  const finishedQueue = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'research active', exact: true }) });
  page.once('dialog', (dialog) => dialog.accept());
  await finishedQueue.getByRole('button', { name: '큐 삭제', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'research active', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '실험', exact: true }).click();
  await expect(page.getByRole('button', { name: '관리 실험', exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/grt-experiments.png', fullPage: true });
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await page.getByRole('textbox', { name: '토큰 이름', exact: true }).fill('browser-reader');
  await page.getByRole('button', { name: '토큰 발급', exact: true }).click();
  const tokenDialog = page.getByRole('dialog', { name: '발급된 토큰' });
  await expect(tokenDialog).toBeVisible();
  const token = await tokenDialog.locator('textarea').inputValue();
  await page.getByRole('button', { name: '보관 완료 · 닫기' }).click();
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await page.getByRole('button', { name: 'API 토큰', exact: true }).click();
  await page.getByLabel('API 토큰', { exact: true }).fill(token);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(
    page.getByText('읽기 전용 접속 · 조회와 다운로드를 사용할 수 있습니다.'),
  ).toBeVisible();
  await page.getByRole('button', { name: '실험', exact: true }).click();
  await expect(page.getByRole('button', { name: '+ 신규 실험' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '수정', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '영구 삭제', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '이어서 학습', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '큐·실행기', exact: true }).click();
  await expect(page.getByRole('button', { name: '+ 큐 만들기' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '일시 정지', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '큐 삭제', exact: true })).toBeDisabled();
  await page.screenshot({ path: '/tmp/grt-queues.png', fullPage: true });
  await page.getByRole('button', { name: '결과', exact: true }).click();
  await expect(page.getByText('표시할 실험이 없습니다.', { exact: false })).toBeVisible();
  await page.getByLabel('실패·부분 결과 포함').check();
  await expect(page.getByRole('button', { name: '관리 실험', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await page.getByLabel('계정', { exact: true }).fill('owner');
  await page.getByLabel('비밀번호', { exact: true }).fill('browser-test-password-123');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await page.getByRole('button', { name: '실험', exact: true }).click();
  page.once('dialog', async (dialog) => {
    expect(dialog.type()).toBe('prompt');
    page.once('dialog', (confirmation) => confirmation.accept());
    await dialog.accept('followup');
  });
  await page.getByRole('button', { name: '이어서 학습', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('verified GRT resume snapshot');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: '영구 삭제', exact: true }).click();
  await expect(page.getByRole('button', { name: '관리 실험', exact: true })).toBeVisible();
  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('복구할 수 없습니다');
    return dialog.accept();
  });
  await page.getByRole('button', { name: '영구 삭제', exact: true }).click();
  await expect(page.getByRole('button', { name: '관리 실험', exact: true })).toHaveCount(0, {
    timeout: 10000, // The experiment list refreshes every seven seconds.
  });
  expect(browserErrors).toEqual([]);
});
