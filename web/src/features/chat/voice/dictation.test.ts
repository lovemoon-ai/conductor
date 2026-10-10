import { describe, expect, it } from 'vitest';
import { joinDictation } from './dictation';

describe('joinDictation', () => {
  it('continues the draft with what was said', () => {
    expect(joinDictation('', '你好。')).toBe('你好。');
    expect(joinDictation('帮我看一下测试，', '然后提交。')).toBe('帮我看一下测试，然后提交。');
    expect(joinDictation('run the tests.', 'Then commit.')).toBe('run the tests. Then commit.');
    expect(joinDictation('改一下 ', '')).toBe('改一下');
  });
});
