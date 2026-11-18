import { afterEach, describe, expect, it } from 'vitest';
import { getLocale, getLocalePreference, resolveLocale, html, msg, setLocale, t, translateError } from './i18n';
import english from './locales/en.json';

afterEach(async () => {
  await setLocale('ko');
});

describe('PC별 한국어·영어 표시', () => {
  it('OS 언어를 따르고 미지원·누락 언어는 영어로 대체한다', async () => {
    for (const language of ['ko-KR', 'ko_KR.UTF-8', 'KO']) {
      expect(resolveLocale('system', language)).toBe('ko');
    }
    for (const language of ['en-US', 'ja-JP', 'fr-FR', 'C', '', undefined]) {
      expect(resolveLocale('system', language)).toBe('en');
    }
    expect(resolveLocale('ko', 'en-US')).toBe('ko');
    expect(resolveLocale('en', 'ko-KR')).toBe('en');
    await setLocale('system');
    expect(getLocalePreference()).toBe('system');
    expect(getLocale()).toBe('en');
  });

  it('앱 문구만 번역하고 사용자 값과 중괄호는 원문 그대로 보존한다', async () => {
    await setLocale('en');
    expect(t('펫')).toBe('Pet');
    const name = '고양이 {1} <script>';
    expect(msg`${name}에게`).toBe('To 고양이 {1} <script>');
    expect(translateError('현재 비밀번호가 올바르지 않습니다')).toBe('The current password is incorrect');
    expect(translateError('provider-specific original content')).toBe('provider-specific original content');
    await setLocale('ko');
    expect(t('펫')).toBe('펫');
  });

  it('템플릿의 UI만 번역하고 이스케이프한 메시지·닉네임은 번역 표식 밖에 둔다', async () => {
    await setLocale('en');
    const content = '고양이 &lt;script&gt;alert(1)&lt;/script&gt;';
    const output = html`<p>메시지 ${content}</p>`;
    expect(output).toContain('Message');
    expect(output).toContain(content);
    expect(output).not.toContain('<script>');
    expect(output).not.toContain('Cat &lt;script&gt;');
  });

  it('모든 영어 항목은 원문의 자리표시자를 빠짐없이 유지한다', () => {
    for (const [source, translated] of Object.entries(english)) {
      expect(translated.trim(), source).not.toBe('');
      expect([...translated.matchAll(/\{\d+\}/gu)].map(match => match[0]).sort(), source).toEqual([...source.matchAll(/\{\d+\}/gu)].map(match => match[0]).sort());
    }
  });
});
