import { test, expect } from '@playwright/test';

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
  await page.getByRole('button', { name: '큐·실행기', exact: true }).click();
  await expect(page.getByRole('button', { name: '+ 큐 만들기' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '일시 정지', exact: true })).toBeDisabled();
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
